/**
 * The host half of the local serve transport (#416): a `SyncProvider` that a
 * headless node hands to its serve runtime in place of CollabV3Sync.
 *
 * The node is the server here. Its database is the source of truth, so a
 * client that connects late, or reconnects after the node restarted, reads the
 * index and the transcripts from that database rather than from a replay
 * buffer. Live changes fan out to every connected stream.
 *
 * What does NOT carry over from the cloud path, on purpose:
 *
 *  - No server binds a create-session claim to a socket. The node answers its
 *    own requests, so the claim generation is a constant and the runtime's
 *    generation re-checks always pass. The runtime still de-duplicates by
 *    requestId and records the initial prompt under `request:<requestId>`.
 *  - Nothing is encrypted at rest on the wire beyond what the cloud path
 *    already encrypts per payload. The link is loopback or the tailnet (which
 *    is WireGuard) and is authenticated by a bearer token.
 *
 * Node-only: imports `node:http`. Never reached from the renderer or mobile.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { AgentMessage } from '../../ai/server/types';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeviceInfo,
  IndexPublishOutcome,
  PushChangeOutcome,
  SessionChange,
  SessionControlMessage,
  SessionIndexData,
  SyncProvider,
  SyncStatus,
  SyncedQueuedPrompt,
} from '../types';
import {
  LOCAL_SERVE_HEARTBEAT_MS,
  LOCAL_SERVE_MAX_BODY_BYTES,
  LOCAL_SERVE_PATHS,
  LOCAL_SERVE_PROTOCOL_VERSION,
  encodeLocalServeEvent,
  isAllowedLocalServeBindAddress,
  type LocalCreateSessionBody,
  type LocalIndexEntry,
  type LocalServeEvent,
  type LocalSessionChangeBody,
  type LocalControlMessageBody,
} from './protocol';

/** The constant claim generation; see the file comment. */
const LOCAL_GENERATION = 1;

export interface LocalServeHostOptions {
  /** Loopback or a tailnet address. Anything else throws at construction. */
  host: string;
  /** 0 picks a free port; read it back from `listen()`. */
  port: number;
  /** Shared bearer token. Empty is refused. */
  token: string;
  /**
   * The identity this host announces. For a host whose database survives a
   * restart, `connectedAt` should be when that state began (the database's
   * creation), not this process's start: the desktop treats a headless host
   * whose `connectedAt` is newer than a session as one that lost the session.
   */
  device: DeviceInfo;
  /** Every session this host owns, read from its database. */
  loadIndex(): Promise<LocalIndexEntry[]>;
  /** One session's transcript, in database order. */
  loadMessages(sessionId: string): Promise<AgentMessage[]>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface LocalServeHost extends SyncProvider {
  /** Seed the index from the database, then start accepting connections. */
  listen(): Promise<{ host: string; port: number }>;
  /** Close every stream and stop listening. */
  close(): Promise<void>;
  /** Streams currently attached. */
  clientCount(): number;
}

function tokensMatch(expected: Buffer, presented: string | undefined): boolean {
  if (!presented?.startsWith('Bearer ')) return false;
  const given = Buffer.from(presented.slice('Bearer '.length), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LOCAL_SERVE_MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw Object.assign(new Error('body is not JSON'), { status: 400 });
  }
}

/**
 * Row ids on this wire are the row's 1-based position in its session, for
 * stored and live rows alike.
 *
 * The synced message store publishes every row with `id: 0`: on the cloud path
 * the room assigns the sequence, and the local autoincrement id means nothing
 * on another device. The desktop mirror keys rows by id and drops any id that
 * is not a positive integer, so the host has to assign one, and it has to be
 * the same number whether the client first sees the row live or on a replay
 * after a reconnect. The ordinal is both. It requires `messageCount` to count
 * every row, hidden ones included, which is why `loadMessages` must return
 * hidden rows and the index must be seeded with the same count.
 */
export function withSessionSequence(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => ({ ...message, id: index + 1 }));
}

/** A `SessionIndexData` publish, as the index row a client reads. */
export function indexEntryFromSessionData(session: SessionIndexData, previous?: LocalIndexEntry): LocalIndexEntry {
  const projectId = session.workspaceId ?? session.workspacePath ?? previous?.projectId ?? '';
  return {
    ...previous,
    sessionId: session.id,
    projectId,
    title: session.title,
    provider: session.provider,
    model: session.model,
    mode: session.mode === 'planning' ? 'planning' : 'agent',
    sessionType: session.sessionType,
    parentSessionId: session.parentSessionId ?? null,
    createdBySessionId: session.createdBySessionId ?? null,
    worktreeId: session.worktreeId,
    hostDeviceId: session.hostDeviceId ?? previous?.hostDeviceId,
    isArchived: session.isArchived,
    isPinned: session.isPinned,
    // A bulk publish built before any message existed says 0; never let it
    // erase a count this host has already advanced.
    messageCount: Math.max(session.messageCount, previous?.messageCount ?? 0),
    lastMessageAt: Math.max(session.updatedAt, previous?.lastMessageAt ?? 0),
    createdAt: session.createdAt,
    updatedAt: Math.max(session.updatedAt, previous?.updatedAt ?? 0),
  };
}

/** Fold a `metadata_updated` change into an index row. Unknown keys are ignored. */
export function applyMetadataToEntry(entry: LocalIndexEntry, metadata: Record<string, unknown>): LocalIndexEntry {
  const next: LocalIndexEntry = { ...entry };
  if (Array.isArray(metadata.queuedPrompts)) {
    next.queuedPrompts = metadata.queuedPrompts as SyncedQueuedPrompt[];
    next.queuedPromptCount = next.queuedPrompts.length;
  }
  if (typeof metadata.isExecuting === 'boolean') next.isExecuting = metadata.isExecuting;
  if (typeof metadata.title === 'string') next.title = metadata.title;
  if (metadata.mode === 'agent' || metadata.mode === 'planning') next.mode = metadata.mode;
  if (typeof metadata.model === 'string') next.model = metadata.model;
  if (typeof metadata.updatedAt === 'number') next.updatedAt = Math.max(next.updatedAt, metadata.updatedAt);
  return next;
}

export function createLocalServeHost(options: LocalServeHostOptions): LocalServeHost {
  if (!isAllowedLocalServeBindAddress(options.host)) {
    throw new Error(
      `[local-serve] refusing to listen on ${options.host}: only loopback or a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) is allowed`,
    );
  }
  if (!options.token) throw new Error('[local-serve] a token is required');
  const expectedToken = Buffer.from(options.token, 'utf8');
  const log = options.log ?? (() => {});

  const entries = new Map<string, LocalIndexEntry>();
  const streams = new Set<ServerResponse>();
  const connected = new Set<string>();
  const remoteChangeListeners = new Map<string, Set<(change: SessionChange) => void>>();
  const statusListeners = new Map<string, Set<(status: SyncStatus) => void>>();
  const indexListeners = new Set<Parameters<NonNullable<SyncProvider['onIndexChange']>>[0]>();
  const createListeners = new Set<(request: CreateSessionRequest) => void>();
  const controlListeners = new Set<(message: SessionControlMessage) => void>();
  let server: Server | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function broadcast(event: LocalServeEvent): void {
    const frame = encodeLocalServeEvent(event);
    for (const stream of streams) stream.write(frame);
  }

  function publishEntry(entry: LocalIndexEntry): void {
    entries.set(entry.sessionId, entry);
    broadcast({ type: 'indexEntry', entry });
  }

  function status(sessionId: string): SyncStatus {
    return { connected: connected.has(sessionId), syncing: false, lastSyncedAt: null, error: null };
  }

  function emitIndexChange(sessionId: string, entry: LocalIndexEntry): void {
    for (const listener of indexListeners) {
      try {
        listener(sessionId, { ...entry });
      } catch (error) {
        log('index-listener-failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokensMatch(expectedToken, req.headers.authorization)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://local-serve');
    const route = `${req.method} ${url.pathname}`;

    if (route === `GET ${LOCAL_SERVE_PATHS.stream}`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(encodeLocalServeEvent({ type: 'hello', protocol: LOCAL_SERVE_PROTOCOL_VERSION, host: options.device }));
      streams.add(res);
      log('client-attached', { clients: streams.size });
      req.on('close', () => {
        streams.delete(res);
        log('client-detached', { clients: streams.size });
      });
      return;
    }

    if (route === `GET ${LOCAL_SERVE_PATHS.index}`) {
      sendJson(res, 200, { sessions: [...entries.values()] });
      return;
    }

    const messagesMatch = /^\/v0\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (req.method === 'GET' && messagesMatch) {
      const sessionId = decodeURIComponent(messagesMatch[1]);
      if (!entries.has(sessionId)) {
        sendJson(res, 404, { error: 'unknown session' });
        return;
      }
      sendJson(res, 200, { messages: withSessionSequence(await options.loadMessages(sessionId)) });
      return;
    }

    if (route === `POST ${LOCAL_SERVE_PATHS.createSession}`) {
      const body = await readJson<LocalCreateSessionBody>(req);
      const request = body?.request;
      if (!request || typeof request.requestId !== 'string' || typeof request.projectId !== 'string') {
        sendJson(res, 400, { error: 'request.requestId and request.projectId are required' });
        return;
      }
      // Stamped before any listener runs, the way CollabV3Sync stamps it before
      // decrypting. Constant here; see the file comment.
      const stamped: CreateSessionRequest = { ...request, receiptGeneration: LOCAL_GENERATION };
      for (const listener of createListeners) listener(stamped);
      sendJson(res, 202, { accepted: true });
      return;
    }

    if (route === `POST ${LOCAL_SERVE_PATHS.sessionChange}`) {
      const body = await readJson<LocalSessionChangeBody>(req);
      const sessionId = body?.sessionId;
      const change = body?.change;
      const entry = typeof sessionId === 'string' ? entries.get(sessionId) : undefined;
      if (!entry || !change) {
        sendJson(res, 404, { outcome: { published: false, retryable: false, reason: 'unknown session' } });
        return;
      }
      // A client writes exactly one thing into a hosted session: its prompt
      // queue. Transcript rows and deletions are the host's alone.
      if (change.type !== 'metadata_updated' || !Array.isArray(change.metadata?.queuedPrompts as unknown)) {
        sendJson(res, 400, { outcome: { published: false, retryable: false, reason: 'clients may only update queuedPrompts' } });
        return;
      }
      const next = applyMetadataToEntry(entry, { queuedPrompts: (change.metadata as Record<string, unknown>).queuedPrompts });
      publishEntry(next);
      emitIndexChange(sessionId!, next);
      sendJson(res, 200, { outcome: { published: true } });
      return;
    }

    if (route === `POST ${LOCAL_SERVE_PATHS.controlMessage}`) {
      const body = await readJson<LocalControlMessageBody>(req);
      const message = body?.message;
      if (!message || typeof message.sessionId !== 'string' || typeof message.type !== 'string') {
        sendJson(res, 400, { error: 'message.sessionId and message.type are required' });
        return;
      }
      for (const listener of controlListeners) listener(message);
      sendJson(res, 202, { accepted: true });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const host: LocalServeHost = {
    async listen() {
      for (const entry of await options.loadIndex()) entries.set(entry.sessionId, entry);
      server = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
          const statusCode = (error as { status?: number }).status ?? 500;
          log('request-failed', { url: req.url, error: error instanceof Error ? error.message : String(error) });
          if (!res.headersSent) sendJson(res, statusCode, { error: error instanceof Error ? error.message : 'failed' });
          else res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.host, () => resolve());
      });
      heartbeat = setInterval(() => {
        for (const stream of streams) stream.write(': heartbeat\n\n');
      }, LOCAL_SERVE_HEARTBEAT_MS);
      heartbeat.unref?.();
      const address = server.address() as AddressInfo;
      log('listening', { host: options.host, port: address.port, sessions: entries.size });
      return { host: options.host, port: address.port };
    },

    async close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      streams.clear();
      const closing = server;
      server = undefined;
      if (!closing) return;
      closing.closeAllConnections?.();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    },

    clientCount: () => streams.size,

    // ---- SyncProvider: the session-room half -------------------------------
    async connect(sessionId) { connected.add(sessionId); },
    disconnect(sessionId) { connected.delete(sessionId); },
    disconnectAll() { connected.clear(); },
    isConnected: (sessionId) => connected.has(sessionId),
    getStatus: status,
    onStatusChange(sessionId, callback) {
      const set = statusListeners.get(sessionId) ?? new Set();
      set.add(callback);
      statusListeners.set(sessionId, set);
      return () => set.delete(callback);
    },
    onRemoteChange(sessionId, callback) {
      // Nothing on this path writes into a hosted session's transcript except
      // the host itself, so there is never a remote change to deliver. Kept so
      // the decorated stores can subscribe without a special case.
      const set = remoteChangeListeners.get(sessionId) ?? new Set();
      set.add(callback);
      remoteChangeListeners.set(sessionId, set);
      return () => set.delete(callback);
    },

    async pushChange(sessionId, change): Promise<PushChangeOutcome> {
      const entry = entries.get(sessionId);
      if (change.type === 'session_deleted') {
        entries.delete(sessionId);
        broadcast({ type: 'indexRemoved', sessionId });
        return { published: true };
      }
      if (change.type === 'message_added') {
        if (!entry) return { published: false, retryable: false, reason: 'session is not in this host index' };
        const at = change.message.createdAt ? new Date(change.message.createdAt).getTime() : Date.now();
        const sequence = entry.messageCount + 1;
        publishEntry({ ...entry, messageCount: sequence, lastMessageAt: Math.max(entry.lastMessageAt, at) });
        broadcast({ type: 'sessionChange', sessionId, change: { type: 'message_added', message: { ...change.message, id: sequence } } });
        return { published: true };
      }
      if (change.type === 'metadata_updated' && entry) {
        publishEntry(applyMetadataToEntry(entry, change.metadata as Record<string, unknown>));
      }
      broadcast({ type: 'sessionChange', sessionId, change });
      // Handed to the transport. A client that is not attached reads the row
      // from this host's database when it connects, so there is nothing to
      // hold and nothing to retry.
      return { published: true };
    },

    async sendSessionMessages(sessionId, messages) {
      for (const message of messages) await host.pushChange(sessionId, { type: 'message_added', message });
      return { published: true };
    },

    // ---- SyncProvider: the index half --------------------------------------
    syncSessionsToIndex(sessions): Promise<IndexPublishOutcome> {
      const ids: string[] = [];
      for (const session of sessions) {
        publishEntry(indexEntryFromSessionData(session, entries.get(session.id)));
        ids.push(session.id);
      }
      return Promise.resolve({ published: true, publishedSessionIds: ids });
    },

    async fetchIndex() {
      return { complete: true, sessions: [...entries.values()], projects: [] };
    },

    getCachedIndexEntry: (sessionId) => entries.get(sessionId) as ReturnType<NonNullable<SyncProvider['getCachedIndexEntry']>>,

    onIndexChange(callback) {
      indexListeners.add(callback);
      return () => indexListeners.delete(callback);
    },

    onCreateSessionRequest(callback) {
      createListeners.add(callback);
      return () => createListeners.delete(callback);
    },

    async sendCreateSessionResponse(response: CreateSessionResponse) {
      broadcast({ type: 'createSessionResponse', response });
    },

    onSessionControlMessage(callback) {
      controlListeners.add(callback);
      return () => controlListeners.delete(callback);
    },

    async sendSessionControlMessage(message) {
      broadcast({ type: 'controlMessage', message });
    },

    getConnectionGeneration: () => LOCAL_GENERATION,
    onConnectionGenerationChange: () => () => {},
    isIndexReady: () => server !== undefined,
    getLocalDeviceInfo: () => options.device,
  };

  return host;
}
