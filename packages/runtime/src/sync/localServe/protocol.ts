/**
 * Wire contract for the local serve transport (#416).
 *
 * A headless `@nimbalyst/node serve` process on the same machine (loopback) or
 * on the user's tailnet hosts sessions for a desktop without the cloud sync
 * room. The node is the server: it owns the sessions, their transcripts and the
 * prompt queue in its own SQLite file, and every desktop that connects is a
 * client reading that state.
 *
 * The protocol is deliberately the SyncProvider vocabulary and nothing more:
 * create-session request and response, index entries, session changes and
 * control messages. Both ends plug into code that already speaks it. The node's
 * serve runtime keeps its create-session claim, queue drain and
 * no-replay-after-restart rules unchanged, and the desktop's RemoteSessionMirror
 * reads the client exactly as it reads CollabV3Sync.
 *
 * Transport: plain HTTP. One long-lived `GET stream` carries host-to-client
 * events as server-sent events; everything client-to-host is a `POST`. No
 * dependency beyond `node:http` on the host and `fetch` on the client.
 *
 * Security: every request carries `Authorization: Bearer <token>`, the token a
 * file the node and the desktop both read. The host binds only to loopback or a
 * tailnet address (`isAllowedLocalServeBindAddress`), so the listener is never
 * on a LAN or public interface by accident. Payloads that the cloud path
 * encrypts end to end (attachments, the workspace context) use a key derived
 * from the same token, so their wire shapes stay identical.
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
} from '../types';
import { deriveEncryptionKey } from '../encryptionKey';

export const LOCAL_SERVE_PROTOCOL_VERSION = 0;

/** One session as the index presents it: the fetchIndex row shape, unchanged. */
export type LocalIndexEntry = Awaited<ReturnType<NonNullable<SyncProvider['fetchIndex']>>>['sessions'][number];

/** Host to client, one per server-sent event. `type` is the discriminator. */
export type LocalServeEvent =
  | { type: 'hello'; protocol: number; host: DeviceInfo }
  | { type: 'indexEntry'; entry: LocalIndexEntry }
  | { type: 'indexRemoved'; sessionId: string }
  | { type: 'sessionChange'; sessionId: string; change: SessionChange }
  | { type: 'createSessionResponse'; response: CreateSessionResponse }
  | { type: 'controlMessage'; message: SessionControlMessage };

export const LOCAL_SERVE_PATHS = {
  stream: '/v0/stream',
  index: '/v0/index',
  messages: (sessionId: string) => `/v0/sessions/${encodeURIComponent(sessionId)}/messages`,
  createSession: '/v0/create-session',
  sessionChange: '/v0/session-change',
  controlMessage: '/v0/control-message',
} as const;

export interface LocalIndexResponse { sessions: LocalIndexEntry[] }
export interface LocalMessagesResponse { messages: AgentMessage[] }
export interface LocalCreateSessionBody { request: CreateSessionRequest }
export interface LocalSessionChangeBody { sessionId: string; change: SessionChange }
export interface LocalSessionChangeResponse { outcome: PushChangeOutcome }
export interface LocalControlMessageBody { message: SessionControlMessage }

/** A queued prompt can carry encrypted images; this bounds a single POST. */
export const LOCAL_SERVE_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Comment line the host writes on the stream so idle proxies and sockets stay up. */
export const LOCAL_SERVE_HEARTBEAT_MS = 15_000;

/**
 * Loopback, or the Tailscale ranges (100.64.0.0/10 and fd7a:115c:a1e0::/48).
 *
 * Anything else is refused at startup. A bearer token on a LAN interface is one
 * leaked file away from remote code execution with the user's permissions, and
 * `0.0.0.0` puts it on every interface at once.
 */
export function isAllowedLocalServeBindAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    if (octets[0] === 127) return true;
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  return /^fd7a:115c:a1e0(:|$)/.test(value);
}

/** Salt for the payload key. Distinct from every personal-sync salt by construction. */
const LOCAL_SERVE_KEY_SALT = 'nimbalyst:local-serve:v0';

/** The AES-GCM key both ends derive from the shared token. */
export function deriveLocalServeKey(token: string): Promise<CryptoKey> {
  if (!token) throw new Error('[local-serve] a token is required to derive the payload key');
  return deriveEncryptionKey(token, LOCAL_SERVE_KEY_SALT);
}

/** Encode one event as a server-sent-event frame. */
export function encodeLocalServeEvent(event: LocalServeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Incremental server-sent-event parser. Feed it decoded text as it arrives;
 * it returns the complete events and keeps the partial tail for the next call.
 * Comment lines (heartbeats) and malformed frames are skipped, never thrown:
 * one bad frame must not take the stream down.
 */
export function createLocalServeEventParser(): (chunk: string) => LocalServeEvent[] {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    const events: LocalServeEvent[] = [];
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) {
        try {
          const parsed = JSON.parse(data) as LocalServeEvent;
          if (parsed && typeof parsed.type === 'string') events.push(parsed);
        } catch {
          // Skipped on purpose; see the doc comment.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
    return events;
  };
}
