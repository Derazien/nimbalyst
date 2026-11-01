/**
 * The client half of the local serve transport (#416): a `SyncProvider` the
 * desktop hands to a `RemoteSessionMirror`, so sessions hosted by a headless
 * node on this machine or the tailnet show in the session list, stream their
 * transcript and take follow-up prompts, with no cloud room in between.
 *
 * It implements exactly the slice the mirror reads: devices, the index, one
 * transcript per watched session, the prompt queue, create-session and control
 * messages. Everything else a desktop does with personal sync (pushing its own
 * sessions, projects, settings, mobile) stays on CollabV3Sync.
 *
 * Uses only `fetch` and a streamed response body, so it runs in the Electron
 * main process and in plain Node alike.
 */

import type { AgentMessage } from '../../ai/server/types';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeviceInfo,
  PushChangeOutcome,
  SessionChange,
  SessionControlMessage,
  SyncProvider,
  SyncStatus,
} from '../types';
import {
  LOCAL_SERVE_PATHS,
  createLocalServeEventParser,
  type LocalIndexEntry,
  type LocalIndexResponse,
  type LocalMessagesResponse,
  type LocalServeEvent,
  type LocalSessionChangeResponse,
} from './protocol';

export interface LocalServeClientOptions {
  /** e.g. `http://127.0.0.1:47615` or `http://100.101.102.103:47615`. */
  baseUrl: string;
  token: string;
  /** This desktop's own identity, as `getLocalDeviceInfo()` reports it. */
  localDevice: DeviceInfo;
  fetch?: typeof fetch;
  /** Delay before re-opening a dropped stream. */
  reconnectDelayMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface LocalServeClient extends SyncProvider {
  /** Open the event stream; reconnects on its own until `close()`. */
  start(): void;
  close(): void;
  /** Resolves once a `hello` has arrived on the current stream. */
  ready(): Promise<void>;
}

const OFFLINE: SyncStatus = { connected: false, syncing: false, lastSyncedAt: null, error: null };

export function createLocalServeClient(options: LocalServeClientOptions): LocalServeClient {
  if (!options.baseUrl || !options.token) throw new Error('[local-serve] baseUrl and token are required');
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const log = options.log ?? (() => {});
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;

  let hostDevice: DeviceInfo | undefined;
  let online = false;
  let closed = false;
  let abort: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let readyWaiters: Array<() => void> = [];

  const entries = new Map<string, LocalIndexEntry>();
  const connected = new Map<string, SyncStatus>();
  const remoteChangeListeners = new Map<string, Set<(change: SessionChange) => void>>();
  const statusListeners = new Map<string, Set<(status: SyncStatus) => void>>();
  const indexListeners = new Set<Parameters<NonNullable<SyncProvider['onIndexChange']>>[0]>();
  const deviceListeners = new Set<(devices: DeviceInfo[]) => void>();
  const createResponseListeners = new Set<(response: CreateSessionResponse) => void>();
  const controlListeners = new Set<(message: SessionControlMessage) => void>();

  const headers = (json = false): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: headers(init.body !== undefined),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok && !(parsed && typeof parsed === 'object' && 'outcome' in parsed)) {
      throw new Error(`[local-serve] ${init.method ?? 'GET'} ${path} failed: ${response.status} ${(parsed as { error?: string }).error ?? ''}`.trim());
    }
    return parsed as T;
  }

  function devices(): DeviceInfo[] {
    return hostDevice ? [{ ...hostDevice, isOnline: online }] : [];
  }

  function emitDevices(): void {
    const snapshot = devices();
    for (const listener of deviceListeners) listener(snapshot);
  }

  function setStatus(sessionId: string, status: SyncStatus): void {
    connected.set(sessionId, status);
    for (const listener of statusListeners.get(sessionId) ?? []) listener(status);
  }

  function applyEntry(entry: LocalIndexEntry): void {
    entries.set(entry.sessionId, entry);
    for (const listener of indexListeners) listener(entry.sessionId, { ...entry });
  }

  function deliver(sessionId: string, change: SessionChange): void {
    if (!connected.get(sessionId)?.connected) return;
    for (const listener of remoteChangeListeners.get(sessionId) ?? []) listener(change);
  }

  function onEvent(event: LocalServeEvent): void {
    switch (event.type) {
      case 'hello':
        hostDevice = event.host;
        online = true;
        emitDevices();
        for (const resolve of readyWaiters) resolve();
        readyWaiters = [];
        // The stream is live from here on, so a re-read cannot miss a change:
        // anything newer than the snapshot also arrives as an event.
        void refreshIndex().catch((error) => log('index-refresh-failed', { error: String(error) }));
        for (const sessionId of connected.keys()) {
          if (connected.get(sessionId)?.connected) void catchUp(sessionId);
        }
        return;
      case 'indexEntry':
        applyEntry(event.entry);
        return;
      case 'indexRemoved':
        entries.delete(event.sessionId);
        return;
      case 'sessionChange':
        deliver(event.sessionId, event.change);
        return;
      case 'createSessionResponse':
        for (const listener of createResponseListeners) listener(event.response);
        return;
      case 'controlMessage':
        for (const listener of controlListeners) listener(event.message);
        return;
    }
  }

  async function refreshIndex(): Promise<LocalIndexEntry[]> {
    const index = await request<LocalIndexResponse>(LOCAL_SERVE_PATHS.index);
    for (const entry of index.sessions) applyEntry(entry);
    return index.sessions;
  }

  /** Replay a session's stored transcript; the mirror de-duplicates by row id. */
  async function catchUp(sessionId: string): Promise<void> {
    const { messages } = await request<LocalMessagesResponse>(LOCAL_SERVE_PATHS.messages(sessionId));
    for (const message of messages) deliver(sessionId, { type: 'message_added', message: message as AgentMessage });
  }

  function goOffline(reason: string): void {
    const wasOnline = online;
    online = false;
    if (wasOnline) {
      log('stream-closed', { reason });
      emitDevices();
    }
    if (!closed && !reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; openStream(); }, reconnectDelayMs);
      (reconnectTimer as { unref?: () => void }).unref?.();
    }
  }

  function openStream(): void {
    if (closed) return;
    const controller = new AbortController();
    abort = controller;
    void (async () => {
      try {
        const response = await doFetch(`${base}${LOCAL_SERVE_PATHS.stream}`, {
          headers: { ...headers(), accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`);
        const parse = createLocalServeEventParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parse(decoder.decode(value, { stream: true }))) onEvent(event);
        }
        if (abort === controller) goOffline('ended');
      } catch (error) {
        if (abort === controller) goOffline(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  const client: LocalServeClient = {
    start() {
      closed = false;
      openStream();
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      abort?.abort();
      abort = undefined;
      online = false;
      emitDevices();
    },
    ready() {
      return online ? Promise.resolve() : new Promise<void>((resolve) => readyWaiters.push(resolve));
    },

    // ---- session rooms -------------------------------------------------------
    async connect(sessionId) {
      setStatus(sessionId, { connected: true, syncing: true, lastSyncedAt: null, error: null });
      try {
        await catchUp(sessionId);
        setStatus(sessionId, { connected: true, syncing: false, lastSyncedAt: Date.now(), error: null });
      } catch (error) {
        setStatus(sessionId, { ...OFFLINE, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    disconnect(sessionId) {
      if (connected.has(sessionId)) setStatus(sessionId, OFFLINE);
      connected.delete(sessionId);
    },
    disconnectAll() {
      for (const sessionId of [...connected.keys()]) client.disconnect(sessionId);
    },
    isConnected: (sessionId) => connected.get(sessionId)?.connected ?? false,
    getStatus: (sessionId) => connected.get(sessionId) ?? OFFLINE,
    onStatusChange(sessionId, callback) {
      const set = statusListeners.get(sessionId) ?? new Set();
      set.add(callback);
      statusListeners.set(sessionId, set);
      return () => set.delete(callback);
    },
    onRemoteChange(sessionId, callback) {
      const set = remoteChangeListeners.get(sessionId) ?? new Set();
      set.add(callback);
      remoteChangeListeners.set(sessionId, set);
      return () => set.delete(callback);
    },

    /** Only a queue update is accepted by the host; the outcome says so. */
    async pushChange(sessionId, change): Promise<PushChangeOutcome> {
      try {
        const { outcome } = await request<LocalSessionChangeResponse>(LOCAL_SERVE_PATHS.sessionChange, {
          method: 'POST',
          body: { sessionId, change },
        });
        return outcome;
      } catch (error) {
        return { published: false, retryable: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    // ---- index ---------------------------------------------------------------
    async fetchIndex() {
      return { complete: true, sessions: await refreshIndex(), projects: [] };
    },
    getCachedIndexEntry: (sessionId) => entries.get(sessionId) as ReturnType<NonNullable<SyncProvider['getCachedIndexEntry']>>,
    onIndexChange(callback) {
      indexListeners.add(callback);
      return () => indexListeners.delete(callback);
    },
    isIndexReady: () => online,

    // ---- devices -------------------------------------------------------------
    getConnectedDevices: devices,
    getLocalDeviceInfo: () => options.localDevice,
    onDeviceStatusChange(callback) {
      deviceListeners.add(callback);
      return () => deviceListeners.delete(callback);
    },

    // ---- requests ------------------------------------------------------------
    async sendCreateSessionRequest(createRequest: CreateSessionRequest) {
      await request(LOCAL_SERVE_PATHS.createSession, { method: 'POST', body: { request: createRequest } });
    },
    onCreateSessionResponse(callback) {
      createResponseListeners.add(callback);
      return () => createResponseListeners.delete(callback);
    },
    async sendSessionControlMessage(message) {
      await request(LOCAL_SERVE_PATHS.controlMessage, { method: 'POST', body: { message } });
    },
    onSessionControlMessage(callback) {
      controlListeners.add(callback);
      return () => controlListeners.delete(callback);
    },
  };

  return client;
}
