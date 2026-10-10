/**
 * Per-session proxy observation session for the Claude CLI (NIM-806, Phase 3 /
 * B3, Slice B). Ties the loopback SSE-tee proxy to the message assembler and
 * owns idempotency, so the production wiring only has to persist + signal.
 *
 * One observation session per CLI session (we spawn one `claude` per Nimbalyst
 * session, so a proxy-per-session is the simplest mapping). Start it BEFORE
 * spawning the CLI, hand `getBaseUrl()` to the spawn config as
 * `ANTHROPIC_BASE_URL`, and `stop()` it on PTY exit.
 *
 * Idempotency: the proxy can re-deliver a turn (CLI retries), so we skip any
 * assistant message whose Anthropic id (`msg_…`) we've already emitted. Empty
 * ids (shouldn't happen) are always emitted since they can't be deduped.
 */

import type * as http from "node:http";
import { startClaudeApiProxy, type ProxyRequestInfo } from "./claudeApiProxy";
import {
  ClaudeApiMessageAssembler,
  type AssembledAssistantMessage,
} from "./claudeApiMessageAssembler";

export interface ClaudeCliProxyObservationDeps {
  /** Nimbalyst session id this proxy observes (for logging / bridge routing). */
  sessionId: string;
  /**
   * Called once per reassembled assistant turn (after id-dedup). `meta` carries
   * what the turn's own request already said about it.
   */
  onAssistantMessage: (msg: AssembledAssistantMessage, meta?: ObservedTurnMeta) => void;
  /**
   * Decide from a request body whether the request belongs to a sub-agent, and if
   * so return the `Agent`/`Task` tool_use id that spawned it. The answer rides
   * along to the assembled turn of THAT request's response, so attribution does
   * not wait on any file. Undefined means "not known", never "the lead's".
   */
  attributeRequest?: (body: Record<string, unknown>, info: ProxyRequestInfo) => string | undefined;
  /** Raw request body of an observed `/v1/messages` (Slice E reads tool_result here). */
  onRequestBody?: (body: Record<string, unknown>, info: ProxyRequestInfo) => void;
  /** Proxy / upstream transport errors. */
  onError?: (err: Error) => void;
  /** Upstream rate-limit (429) / overloaded (529) — surfaced to the user. */
  onRateLimit?: (info: { statusCode: number; retryAfter?: string }) => void;
  /** Any non-2xx upstream response (>= 400) with a bounded error body — surfaced in the transcript. */
  onUpstreamError?: (info: { statusCode: number; body?: string; retryAfter?: string }) => void;
  /**
   * Upstream the proxy forwards `/v1/messages` to. Defaults to the real Anthropic
   * API. Set in production to a user-configured loopback middleware proxy
   * (token-compression / gateway / cache), and in tests to a fake upstream.
   */
  upstreamUrl?: string;
}

/** What an observed request established about the turn its response produced. */
export interface ObservedTurnMeta {
  /** Spawning tool_use id, when the request matched a known sub-agent spawn. */
  parentToolUseId?: string;
}

/**
 * Bound on remembered attributions. An entry is dropped when its response's turn
 * is assembled; this only matters for streams that never finish.
 */
const MAX_PENDING_REQUEST_PARENTS = 256;

export class ClaudeCliProxyObservation {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly assembler: ClaudeApiMessageAssembler;
  private readonly emittedMessageIds = new Set<string>();
  /** Proxy request id to the sub-agent spawn its request matched. */
  private readonly requestParents = new Map<string, string>();

  constructor(private readonly deps: ClaudeCliProxyObservationDeps) {
    this.assembler = new ClaudeApiMessageAssembler((msg, requestId) => this.handleAssembled(msg, requestId));
  }

  /** Start the proxy on a loopback port. Returns the base URL for ANTHROPIC_BASE_URL. */
  async start(): Promise<{ baseUrl: string }> {
    if (this.server) return { baseUrl: this.getBaseUrl()! };
    const { server, port } = await startClaudeApiProxy(
      {
        onSSEEvent: (event, info) => {
          if (!info.observe) return;
          // Pass requestId so concurrent sub-agent + parent streams assemble in
          // isolation (the CLI runs Task sub-agents through this same proxy).
          this.assembler.processSSE(event, info.requestId);
        },
        onRequestBody: (body, info) => {
          this.noteRequestAttribution(body, info);
          this.deps.onRequestBody?.(body, info);
        },
        onProxyError: (err) => this.deps.onError?.(err),
        onRateLimit: (info) => this.deps.onRateLimit?.(info),
        onUpstreamError: (info) => this.deps.onUpstreamError?.(info),
      },
      { upstreamUrl: this.deps.upstreamUrl },
    );
    this.server = server;
    this.port = port;
    return { baseUrl: this.getBaseUrl()! };
  }

  getBaseUrl(): string | null {
    return this.port == null ? null : `http://127.0.0.1:${this.port}`;
  }

  /** Tear down the proxy and drop in-flight assembler state. */
  stop(): void {
    this.assembler.reset();
    this.requestParents.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      server.close();
    }
  }

  private noteRequestAttribution(body: Record<string, unknown>, info: ProxyRequestInfo): void {
    if (!this.deps.attributeRequest) return;
    let parentToolUseId: string | undefined;
    try {
      parentToolUseId = this.deps.attributeRequest(body, info);
    } catch (err) {
      // Attribution is best-effort; the sidecar lookup is still behind it.
      this.deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    if (!parentToolUseId) return;
    if (this.requestParents.size >= MAX_PENDING_REQUEST_PARENTS) {
      const oldest = this.requestParents.keys().next().value;
      if (oldest !== undefined) this.requestParents.delete(oldest);
    }
    this.requestParents.set(info.requestId, parentToolUseId);
  }

  private handleAssembled(msg: AssembledAssistantMessage, requestId: string): void {
    const parentToolUseId = this.requestParents.get(requestId);
    this.requestParents.delete(requestId);
    if (msg.id) {
      if (this.emittedMessageIds.has(msg.id)) return;
      this.emittedMessageIds.add(msg.id);
    }
    this.deps.onAssistantMessage(msg, parentToolUseId ? { parentToolUseId } : undefined);
  }
}
