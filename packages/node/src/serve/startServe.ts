/**
 * Wire the real thing: credentials, sockets, stores, git, the turn runner.
 *
 * `serveRuntime.ts` holds every decision; this file holds every dependency. The
 * split is deliberate -- everything below is untestable without a network, and
 * anything untestable that also makes a decision is a decision that ships
 * unverified.
 *
 * Ordering that matters:
 *
 *  1. The credential is refreshed BEFORE the socket opens. Opening first and
 *     discovering the credential is revoked costs a connection the server has
 *     to reject and buries the real cause under a WebSocket error.
 *  2. Both stores are decorated at `NimbalystNode.open`, not after. The
 *     repositories are module-level singletons; a write that lands between
 *     `open()` and a later `setStore` is persisted locally and never synced.
 *  3. `deviceAnnounce` is not sent from here. CollabV3Sync announces on open
 *     and re-announces every 30s from `getDeviceInfo`, which is why that is a
 *     callback and not a fixed object.
 */

import { createRequire } from 'node:module';

import { createCollabV3Sync } from '@nimbalyst/runtime/sync/CollabV3Sync';
import {
  deriveEncryptionKey,
  personalSyncEncryptionSalt,
} from '@nimbalyst/runtime/sync/encryptionKey';
import { setSyncClientInfo } from '@nimbalyst/runtime/sync/syncClientInfo';
import { nodeAccessTokenAsPersonalJwt } from '@nimbalyst/runtime/sync/nodeCredentialToken';
import type { SyncConfig, SyncProvider } from '@nimbalyst/runtime/sync/types';

import { requireSyncSettings, type LoadedConfig } from '../config.js';
import {
  CredentialRevokedError,
  createCredentialRefresher,
} from './credentials.js';
import { createHeadlessDeviceInfo } from './deviceIdentity.js';
import { ensureIndexSynced } from './indexEligibility.js';
import { createRefreshLoop, shutdownServe } from './lifecycle.js';
import { createStderrLogger, type Logger } from './log.js';
import { DEFAULT_CHECKOUT_ROOT, confineCheckout, ensureCheckout } from './repoCheckout.js';
import { loadWorkspaces } from './workspaces.js';
import { openServeHost } from './serveHost.js';

const require = createRequire(import.meta.url);

/**
 * The branded personal-member-id type, reached through `SyncConfig`.
 *
 * `asPersonalMemberId` lives in `@nimbalyst/runtime/auth/jwtScopes`, which has
 * no `node` export condition -- its exports entry points at `dist/`, which a
 * Node consumer never builds, so importing it from here does not typecheck even
 * though the module IS emitted into `dist-node/`. Deriving the type off
 * `SyncConfig` keeps the brand (a team member id still cannot be passed where
 * this is required) without the unresolvable import. Reported to the runtime
 * slice; delete this the day that export gains its condition.
 */
type PersonalMemberId = SyncConfig['personalMemberId'];

/** How often to re-establish `synced` on a socket this process did not reopen. */
const ELIGIBILITY_HEARTBEAT_MS = 5 * 60 * 1000;

export interface ServeOptions {
  config: LoadedConfig;
  log?: Logger;
  /** Resolves when the process should shut down (SIGTERM). */
  signal?: AbortSignal;
}

export interface ServeResult {
  /** 0 on a clean shutdown, 3 when the credential was revoked. */
  exitCode: number;
}

function packageVersion(): string {
  try {
    return (require('../../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const log = options.log ?? createStderrLogger();
  const config = options.config;
  const sync = requireSyncSettings(config);

  if (!config.resolvedWorkspacesPath) {
    throw new Error('[nimbalyst-node] "workspacesPath" is required to run "serve"');
  }
  const workspacesPath = config.resolvedWorkspacesPath;
  const checkoutRoot = config.checkoutRoot ?? DEFAULT_CHECKOUT_ROOT;

  setSyncClientInfo({ platform: 'headless', version: packageVersion() });

  const credentials = createCredentialRefresher({
    serverUrl: sync.serverUrl,
    credentialPath: sync.credentialPath,
    log,
  });

  // Fail before opening anything: a revoked credential is terminal and the
  // operator needs the reason, not a socket error.
  try {
    await credentials.getAccessToken();
  } catch (error) {
    if (error instanceof CredentialRevokedError) {
      log('credential-revoked', { reason: error.reason });
      return { exitCode: 3 };
    }
    throw error;
  }
  log('credential-ready', { nodeId: credentials.nodeId(), serverUrl: sync.serverUrl });

  // The boundary where a raw string becomes a branded personal member id: the
  // desktop wrote `sync.personalUserId` into the config after resolving the
  // user's PERSONAL org membership. A team member id here would derive a
  // different key and silently orphan every encrypted row.
  const personalMemberId = sync.personalUserId as PersonalMemberId;
  const encryptionKey = await deriveEncryptionKey(
    sync.encryptionKeySeed,
    // The PERSONAL member id, never a team one: the salt is what makes this
    // node's key bit-identical to the desktop's and the phone's.
    personalSyncEncryptionSalt(personalMemberId),
  );

  const getDeviceInfo = createHeadlessDeviceInfo(sync, { appVersion: packageVersion() });

  // Shutdown state is established BEFORE the provider, because
  // `createCollabV3Sync` starts connecting immediately and its first `getJwt`
  // can land before the rest of this function has run. A `const` timer declared
  // further down would still be in its temporal dead zone at that point.
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let refreshLoop: ReturnType<typeof createRefreshLoop> | undefined;
  let exitCode = 0;
  let stopping = false;
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    refreshLoop?.stop();
    resolveStopped();
  }

  /**
   * A 400 from the refresh endpoint is terminal, and CollabV3Sync swallows every
   * `getJwt` failure into its reconnect-with-backoff loop. Without this latch a
   * revocation looks exactly like a flapping network and the process spins until
   * the next proactive refresh notices, up to twelve minutes later.
   */
  function stopWithRevokedCredential(reason: string): void {
    if (stopping) return;
    log('credential-revoked', { reason });
    exitCode = 3;
    shutdown();
  }

  /**
   * The index socket's identity.
   *
   * Read straight from the provider, which bumps its counter on every index
   * disconnect. An earlier version sampled `isIndexReady()` and inferred a
   * change from the transition -- which cannot see a disconnect and reconnect
   * that both complete between two samples, exactly the case the twelve-minute
   * rotation produces. The server is the final authority either way: it rejects
   * a response from a socket that does not hold the claim.
   */
  function connectionGeneration(): number {
    return syncProvider?.getConnectionGeneration?.() ?? 0;
  }

  const syncProvider: SyncProvider = createCollabV3Sync({
    serverUrl: sync.serverUrl,
    orgId: sync.personalOrgId,
    personalMemberId,
    getJwt: async () => {
      try {
        return nodeAccessTokenAsPersonalJwt(await credentials.getAccessToken());
      } catch (error) {
        if (error instanceof CredentialRevokedError) stopWithRevokedCredential(error.reason);
        throw error;
      }
    },
    encryptionKey,
    getDeviceInfo,
  });

  const { node, runtime, unsubscribes } = await openServeHost({
    config,
    log,
    deviceId: sync.deviceId,
    provider: syncProvider,
    encryptionKey,
    workspaces: {
      loadWorkspaces: () => loadWorkspaces(workspacesPath),
      ensureCheckout: (mapping) => ensureCheckout(mapping, { checkoutRoot }),
      confineCheckout: (mapping) => confineCheckout(mapping, { checkoutRoot }),
    },
    connectionGeneration,
  });

  log('connected', { deviceId: sync.deviceId, serverUrl: sync.serverUrl });

  // Announced is not the same as eligible: the server also requires this socket
  // to be `synced`, which only an index read produces. See indexEligibility.ts.
  await ensureIndexSynced({ provider: syncProvider, log });
  log('announced', { deviceId: sync.deviceId, deviceType: 'headless' });

  log('serving', {
    deviceId: sync.deviceId,
    serverUrl: sync.serverUrl,
    workspaces: workspacesPath,
  });

  // `synced` is per-socket server state, so a reconnect this node did not
  // initiate (server hibernation, network blip) silently drops it back out of
  // host selection. Re-establish it on a slow heartbeat; on protocol v2 this is
  // a delta read, not a bootstrap.
  const eligibilityTimer = setInterval(() => {
    void ensureIndexSynced({ provider: syncProvider, log });
  }, ELIGIBILITY_HEARTBEAT_MS);
  eligibilityTimer.unref?.();
  timers.push(eligibilityTimer);

  // Rotation, and the retry policy for a rotation that could not happen. A 400
  // is terminal and stops the loop for good; a network error backs off and tries
  // again well inside the token's remaining life. See lifecycle.ts.
  refreshLoop = createRefreshLoop({
    log,
    onRevoked: stopWithRevokedCredential,
    rotate: async () => {
      await credentials.refresh();
      // A live socket still carries the retired token. Force a fresh one now,
      // on our schedule, rather than letting the server close it at 4003.
      await syncProvider.reconnectIndex?.();
      // The socket that held any outstanding create-session claim is gone; the
      // provider's own generation counter has already moved.
      log('reconnected', { deviceId: sync.deviceId, generation: connectionGeneration() });
      // A new socket starts un-synced; without this the node stays connected
      // and announced but stops being offered work.
      await ensureIndexSynced({ provider: syncProvider, log });
    },
  });
  // Not if shutdown already ran: `stopWithRevokedCredential` can fire from the
  // provider's very first `getJwt`, before this line, and starting a rotation
  // loop against a credential we already know is gone is pointless work.
  if (!stopping) refreshLoop.start();

  options.signal?.addEventListener('abort', shutdown, { once: true });
  if (options.signal?.aborted) shutdown();

  await stopped;

  await shutdownServe({
    runtime,
    unsubscribes,
    revoked: exitCode === 3,
    log,
    disconnect: () => syncProvider.disconnectAll(),
  });

  node.close();
  log('stopped', { exitCode });
  return { exitCode };
}
