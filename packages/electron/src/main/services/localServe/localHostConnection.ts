/**
 * Keeps the desktop's local-host mirror connected to the host saved in
 * Settings (#416).
 *
 * `connect()` is idempotent and reads the store every time: called at startup,
 * after a save and after a remove, it converges on "one client for the saved
 * host, or none". The client reconnects on its own when the node restarts, so
 * nothing here polls.
 */

import { createLocalServeClient, type LocalServeClient } from '@nimbalyst/runtime/sync/localServe/LocalServeClient';
import { LOCAL_SERVE_PATHS, deriveLocalServeKey } from '@nimbalyst/runtime/sync/localServe/protocol';
import type { DeviceInfo, SyncProvider } from '@nimbalyst/runtime/sync/types';

import { logger } from '../../utils/logger';
import type { LocalHostStore } from './localHostStore';

export interface LocalHostStatus {
  configured: boolean;
  url?: string;
  savedAt?: string;
  online: boolean;
  hostName?: string;
  hostDeviceId?: string;
  sessionCount?: number;
  error?: string;
}

export interface LocalHostTestResult {
  ok: boolean;
  hostName?: string;
  sessionCount?: number;
  error?: string;
}

export interface LocalHostConnectionDeps {
  store: LocalHostStore;
  target: { setLocalProvider(provider: SyncProvider | null, key?: CryptoKey | null): void };
  /** This desktop's id; anything that is not the node's own id. */
  localDeviceId(): string;
  fetch?: typeof fetch;
}

export interface LocalHostConnection {
  connect(): Promise<void>;
  disconnect(): void;
  status(): Promise<LocalHostStatus>;
  /** Reach a host with a token without saving either. */
  test(url: string, token: string): Promise<LocalHostTestResult>;
}

export function createLocalHostConnection(deps: LocalHostConnectionDeps): LocalHostConnection {
  const doFetch = deps.fetch ?? fetch;
  let client: LocalServeClient | null = null;
  let connectedUrl: string | null = null;
  let lastError: string | undefined;

  function drop(): void {
    if (!client) return;
    deps.target.setLocalProvider(null);
    client.close();
    client = null;
    connectedUrl = null;
  }

  async function test(url: string, token: string): Promise<LocalHostTestResult> {
    try {
      const auth = { authorization: `Bearer ${token}` };
      const index = await doFetch(`${url}${LOCAL_SERVE_PATHS.index}`, { headers: auth, signal: AbortSignal.timeout(5000) });
      if (index.status === 401) return { ok: false, error: 'The node refused the token.' };
      if (!index.ok) return { ok: false, error: `The node answered ${index.status}.` };
      const { sessions } = await index.json() as { sessions: unknown[] };
      // The hello frame carries the host's name; read it and let go.
      const controller = new AbortController();
      const stream = await doFetch(`${url}${LOCAL_SERVE_PATHS.stream}`, { headers: { ...auth, accept: 'text/event-stream' }, signal: controller.signal });
      let hostName: string | undefined;
      try {
        const reader = stream.body?.getReader();
        const first = reader ? await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 3000))]) : undefined;
        const text = first && 'value' in first && first.value ? new TextDecoder().decode(first.value) : '';
        const data = /^data: (.*)$/m.exec(text)?.[1];
        hostName = data ? (JSON.parse(data) as { host?: DeviceInfo }).host?.name : undefined;
      } finally {
        controller.abort();
      }
      return { ok: true, hostName, sessionCount: sessions.length };
    } catch (error) {
      return { ok: false, error: `Could not reach the node: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    async connect() {
      const saved = deps.store.read();
      const token = saved ? deps.store.readToken() : null;
      if (!saved || !token) {
        if (saved && !token) lastError = 'The saved token could not be decrypted. Save the host again.';
        drop();
        return;
      }
      if (client && connectedUrl === saved.url) return;
      drop();
      lastError = undefined;
      const next = createLocalServeClient({
        baseUrl: saved.url,
        token,
        localDevice: { deviceId: deps.localDeviceId(), name: 'This desktop', type: 'desktop', platform: process.platform, connectedAt: Date.now(), lastActiveAt: Date.now() },
        log: (event, fields) => logger.main.info(`[LocalHost] ${event}`, fields ?? {}),
      });
      client = next;
      connectedUrl = saved.url;
      next.start();
      deps.target.setLocalProvider(next, await deriveLocalServeKey(token));
      logger.main.info('[LocalHost] connecting', { url: saved.url });
    },

    disconnect: drop,

    async status() {
      const saved = deps.store.read();
      if (!saved) return { configured: false, online: false, ...(lastError ? { error: lastError } : {}) };
      const host = client?.getConnectedDevices?.()[0];
      const online = !!client?.isIndexReady?.();
      let sessionCount: number | undefined;
      if (online && client?.fetchIndex) {
        try { sessionCount = (await client.fetchIndex()).sessions.length; } catch { /* Shown as unknown. */ }
      }
      return {
        configured: true,
        url: saved.url,
        savedAt: saved.savedAt,
        online,
        hostName: host?.name,
        hostDeviceId: host?.deviceId,
        sessionCount,
        ...(lastError ? { error: lastError } : {}),
      };
    },

    test,
  };
}
