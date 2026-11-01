/**
 * `serve --transport local` (#416): host sessions for a desktop on this
 * machine or the tailnet, with no cloud room.
 *
 * Same serve runtime as the cloud path (`openServeHost`); what differs is only
 * the provider and what it needs:
 *
 *  - No credential, no refresh loop, no index-eligibility heartbeat. The node
 *    is the server, so it is eligible the moment it listens.
 *  - A bearer token file instead of a personal-sync key. The payload key is
 *    derived from that token, so attachments and the workspace context keep
 *    their encrypted wire shape.
 *  - Optional in-place workspaces: a project under `local.inPlaceRoots` runs in
 *    the desktop's own directory, with no workspaces mapping and no git.
 *
 * Restart rules carry over unchanged because they live in the runtime: a
 * prompt left `pending` is driven at startup, one left `executing` is failed
 * with a note in the transcript, never re-run.
 */

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';

import { createLocalServeHost, indexEntryFromSessionData } from '@nimbalyst/runtime/sync/localServe/LocalServeHost';
import { deriveLocalServeKey, type LocalIndexEntry } from '@nimbalyst/runtime/sync/localServe/protocol';
import { setSyncClientInfo } from '@nimbalyst/runtime/sync/syncClientInfo';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';

import type { NimbalystNode } from '../NimbalystNode.js';
import { requireLocalSettings, type LoadedConfig } from '../config.js';
import { confineInPlace, inPlaceMapping } from './inPlaceWorkspaces.js';
import { shutdownServe } from './lifecycle.js';
import { createStderrLogger, type Logger } from './log.js';
import { DEFAULT_CHECKOUT_ROOT, confineCheckout, ensureCheckout } from './repoCheckout.js';
import { openServeHost } from './serveHost.js';
import type { RunTurnInput } from './serveRuntime.js';
import { loadWorkspaces, type WorkspaceMapping } from './workspaces.js';

const require = createRequire(import.meta.url);

export interface LocalServeOptions {
  config: LoadedConfig;
  log?: Logger;
  signal?: AbortSignal;
  /** Called once the port is open, with the address actually bound. */
  onListening?: (address: { host: string; port: number }) => void;
  /** Tests only: run turns without spawning `claude`. */
  runTurnOverride?: (node: NimbalystNode, input: RunTurnInput) => Promise<{ error?: string }>;
}

function packageVersion(): string {
  try {
    return (require('../../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** When this node's state began: the database file's creation, not this process. */
function stateSince(databasePath: string): number {
  try {
    const stat = statSync(databasePath);
    return Math.min(stat.birthtimeMs || stat.ctimeMs, stat.mtimeMs);
  } catch {
    return Date.now();
  }
}

function readToken(tokenPath: string): string {
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf-8').trim();
  } catch (error) {
    throw new Error(`[nimbalyst-node] could not read local.tokenPath ${tokenPath}: ${(error as Error).message}`);
  }
  if (token.length < 32) throw new Error(`[nimbalyst-node] the token in ${tokenPath} must be at least 32 characters`);
  return token;
}

export async function serveLocal(options: LocalServeOptions): Promise<{ exitCode: number }> {
  const log = options.log ?? createStderrLogger();
  const config = options.config;
  const local = requireLocalSettings(config);
  const token = readToken(local.resolvedTokenPath);
  const encryptionKey = await deriveLocalServeKey(token);
  const roots = local.inPlaceRoots ?? [];
  const workspacesPath = config.resolvedWorkspacesPath;
  const checkoutRoot = config.checkoutRoot ?? DEFAULT_CHECKOUT_ROOT;

  setSyncClientInfo({ platform: 'headless', version: packageVersion() });

  // Opened below; the host only calls these once it is listening.
  let opened: NimbalystNode | undefined;

  const provider = createLocalServeHost({
    host: local.host,
    port: local.port,
    token,
    device: {
      deviceId: local.deviceId,
      name: local.deviceName ?? `${os.hostname()} (headless)`,
      type: 'headless',
      platform: process.platform,
      appVersion: packageVersion(),
      // See LocalServeHostOptions.device: a durable host reports when its
      // state began, or the desktop freezes every session after a restart.
      connectedAt: stateSince(config.resolvedDatabasePath),
      lastActiveAt: Date.now(),
    },
    log,
    loadIndex: async () => {
      if (!opened) return [];
      const ids = (opened.database.prepare('SELECT id FROM ai_sessions').all() as Array<{ id: string }>).map((row) => row.id);
      const sessions = (await Promise.all(ids.map((id) => opened!.store.get(id)))).filter((session) => session !== null);
      // Every row, hidden ones included: this count is where the wire's row
      // sequence continues from (see withSessionSequence).
      const counts = new Map(
        (opened.database.prepare('SELECT session_id, COUNT(*) AS count FROM ai_agent_messages GROUP BY session_id').all() as Array<{ session_id: string; count: number }>)
          .map((row) => [row.session_id, Number(row.count)] as const),
      );
      const entries: LocalIndexEntry[] = [];
      for (const session of sessions) {
        const hostDeviceId = (session.metadata as { hostDeviceId?: string } | undefined)?.hostDeviceId;
        // Only sessions this node hosts. A row without attribution was created
        // by the one-turn CLI against this database and was never offered.
        if (hostDeviceId !== local.deviceId) continue;
        entries.push(indexEntryFromSessionData({
          id: session.id,
          title: session.title ?? 'Untitled',
          provider: session.provider,
          model: session.model,
          mode: session.mode,
          sessionType: session.sessionType,
          parentSessionId: session.parentSessionId ?? null,
          hostDeviceId,
          workspaceId: session.workspacePath,
          messageCount: counts.get(session.id) ?? 0,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }));
      }
      return entries;
    },
    loadMessages: (sessionId) => AgentMessagesRepository.list(sessionId, { includeHidden: true }),
  });

  const { node, runtime, unsubscribes } = await openServeHost({
    config,
    log,
    deviceId: local.deviceId,
    provider,
    encryptionKey,
    workspaces: {
      loadWorkspaces: (projectId) => {
        const inPlace = inPlaceMapping(projectId, roots);
        if (inPlace) return [inPlace];
        return workspacesPath ? loadWorkspaces(workspacesPath) : [];
      },
      ensureCheckout: async (mapping: WorkspaceMapping) => {
        if (!mapping.inPlace) return ensureCheckout(mapping, { checkoutRoot });
        confineInPlace(mapping, roots);
        // Nothing to fetch: the desktop's tree is the working tree.
        return 'updated';
      },
      confineCheckout: (mapping) => (mapping.inPlace
        ? confineInPlace(mapping, roots)
        : confineCheckout(mapping, { checkoutRoot })),
    },
    connectionGeneration: () => provider.getConnectionGeneration?.() ?? 0,
    runTurnOverride: options.runTurnOverride,
  });
  opened = node;

  const address = await provider.listen();
  log('serving', { deviceId: local.deviceId, transport: 'local', host: address.host, port: address.port, inPlaceRoots: roots });
  options.onListening?.(address);

  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) return resolve();
    options.signal?.addEventListener('abort', () => resolve(), { once: true });
  });

  await shutdownServe({
    runtime,
    unsubscribes,
    revoked: false,
    log,
    disconnect: () => provider.disconnectAll(),
  });
  await provider.close();
  node.close();
  log('stopped', { exitCode: 0 });
  return { exitCode: 0 };
}
