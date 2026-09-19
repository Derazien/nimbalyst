/**
 * KimiACPRawParser -- parses Kimi Code ACP raw messages into canonical event
 * descriptors.
 *
 * Output rows stored by KimiCodeProvider have the envelope:
 *   { type: 'session/update', sessionId, update }
 * where `update` is an ACP `SessionUpdate` discriminator (agent_message_chunk,
 * agent_thought_chunk, tool_call, tool_call_update, usage_update, ...).
 *
 * Permission requests are stored as:
 *   { type: 'session/request_permission', sessionId, request }
 *
 * Like the Copilot pipeline, per-chunk text is NOT rendered from
 * agent_message_chunk rows: KimiCodeProvider.storeAssistantResponse writes a
 * turn-final `item.completed` row carrying the full assistant text, and that
 * row is the single source of the canonical assistant_message.
 *
 * Authoritative shape reference: KimiACPProtocol.handleSessionUpdate() and
 * KimiACPProtocol.mapSessionUpdate() in
 * packages/runtime/src/ai/server/protocols/KimiACPProtocol.ts.
 *
 * Input messages (user prompts) are plain text written by
 * KimiCodeProvider.sendMessage; we mirror the Copilot/CodexACP parser
 * convention so reload behaves the same as live streaming.
 */

import path from 'path';
import type { RawMessage } from '../TranscriptTransformer';
import { parseMcpToolName } from '../utils';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

interface KimiACPRawEvent {
  type?: string;
  sessionId?: string;
  update?: ACPSessionUpdate;
  request?: ACPRequestPermission;
}

interface ACPSessionUpdate {
  sessionUpdate?: string;
  content?: ACPContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  [key: string]: unknown;
}

interface ACPContentBlock {
  type?: string;
  text?: string;
  uri?: string;
  mimeType?: string;
}

interface ACPRequestPermission {
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: ACPToolCallLocation[] | null;
  };
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

interface ACPToolCallLocation {
  path?: unknown;
  line?: unknown;
}

export class KimiACPRawParser implements IRawMessageParser {
  // Text is accumulated per turn but never emitted per chunk -- the
  // item.completed row carries the full assistant response.
  private accumulatedText = '';
  // Tracks tool calls we've already emitted a started descriptor for in this
  // batch so a tool_call_update or a session/request_permission row for the
  // same call doesn't double-create.
  private readonly emittedStartedToolCallIds = new Set<string>();
  // Real kimi announces a tool with a bare title first and sends the
  // arguments in a later in_progress update. The start is held here until an
  // update carries rawInput or locations (or the call ends), so the card is
  // never written with empty arguments.
  private readonly pendingStarts = new Map<string, { title?: string; kind?: string }>();

  async parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    if (msg.direction === 'input') {
      return this.parseInputMessage(msg);
    }

    return this.parseOutputMessage(msg, context);
  }

  // ---------------------------------------------------------------------------
  // Input messages (user prompts and system reminders)
  // ---------------------------------------------------------------------------

  private parseInputMessage(msg: RawMessage): CanonicalEventDescriptor[] {
    const content = String(msg.content ?? '').trim();
    if (!content) return [];

    if (this.isSystemReminderContent(content, msg.metadata)) {
      return [{
        type: 'system_message',
        text: content,
        systemType: 'status',
        createdAt: msg.createdAt,
      }];
    }

    return [{
      type: 'user_message',
      text: content,
      mode: (msg.metadata?.mode as 'agent' | 'planning') ?? 'agent',
      createdAt: msg.createdAt,
    }];
  }

  private isSystemReminderContent(
    content: string,
    metadata?: Record<string, unknown>,
  ): boolean {
    return (
      metadata?.promptType === 'system_reminder' ||
      /<SYSTEM_REMINDER>[\s\S]*<\/SYSTEM_REMINDER>/.test(content)
    );
  }

  // ---------------------------------------------------------------------------
  // Output messages (item.completed + session/update + session/request_permission)
  // ---------------------------------------------------------------------------

  private async parseOutputMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      // Plain text output = assistant response
      const text = String(msg.content ?? '').trim();
      if (text) {
        return [{ type: 'assistant_message', text, createdAt: msg.createdAt }];
      }
      return [];
    }

    // Turn-final assistant synthesis written by the provider after a turn
    // completes (Codex-compatible item.completed format).
    if (parsed.type === 'item.completed' && parsed.item) {
      return this.parseItemCompleted(parsed.item as Record<string, unknown>, msg);
    }

    // Kimi Code CLI terminal mode: a turn kimi reported as failed (quota,
    // auth, provider error), with kimi's own message.
    if (parsed.type === 'turn/failed' && typeof parsed.message === 'string') {
      return [{ type: 'system_message', text: parsed.message, systemType: 'error', createdAt: msg.createdAt }];
    }

    const event = parsed as KimiACPRawEvent;

    if (event.type === 'session/request_permission') {
      return this.parseRequestPermission(msg, event, context);
    }

    // session/request_permission_preview is informational only (the protocol
    // also emits a tool_call ProtocolEvent for it which carries the canonical
    // arguments). Skip it here to avoid double-counting.
    if (event.type === 'session/request_permission_preview') {
      return [];
    }

    if (event.type !== 'session/update' || !event.update) {
      return [];
    }

    return this.parseSessionUpdate(msg, event.update, context);
  }

  private parseItemCompleted(
    item: Record<string, unknown>,
    msg: RawMessage,
  ): CanonicalEventDescriptor[] {
    if (item.type !== 'message' || item.role !== 'assistant') return [];

    const content = item.content;
    if (!Array.isArray(content)) return [];

    const textParts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const p = part as Record<string, unknown>;
        if (p.type === 'output_text' && typeof p.text === 'string') {
          textParts.push(p.text);
        }
      }
    }

    const text = textParts.join('');
    if (!text) return [];

    return [{ type: 'assistant_message', text, createdAt: msg.createdAt }];
  }

  private async parseSessionUpdate(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const kind = update.sessionUpdate;

    switch (kind) {
      case 'agent_message_chunk': {
        const block = update.content;
        if (block?.type === 'text' && typeof block.text === 'string') {
          this.accumulatedText += block.text;
        }
        // Don't emit per-chunk -- the item.completed message has the full text.
        return [];
      }

      case 'agent_thought_chunk':
        // Reasoning is not rendered in the transcript.
        return [];

      case 'tool_call':
        return this.parseToolCall(msg, update, context);

      case 'tool_call_update':
        return this.parseToolCallUpdate(msg, update, context);

      case 'usage_update':
        // Token counts ride the provider's `complete` event; no canonical
        // event from the raw row.
        return [];

      default:
        // plan, current_mode_update, and anything new: stored raw only.
        return [];
    }
  }

  private parseToolCall(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!callId) return [];

    return this.startOrHold(msg, context, callId, update.title, update.kind, update.rawInput,
      update.locations as ACPToolCallLocation[] | null | undefined);
  }

  /**
   * Emit the started descriptor now when the call already carries arguments,
   * otherwise hold it until an update brings them. A call another row (or an
   * earlier batch) already started is never started twice.
   */
  private startOrHold(
    msg: RawMessage,
    context: ParseContext,
    callId: string,
    title: string | undefined,
    kind: string | undefined,
    rawInput: unknown,
    locations: ACPToolCallLocation[] | null | undefined,
  ): CanonicalEventDescriptor[] {
    if (this.emittedStartedToolCallIds.has(callId) || context.hasToolCall(callId)) {
      return [];
    }
    if (!this.hasArguments(rawInput, locations)) {
      const held = this.pendingStarts.get(callId);
      this.pendingStarts.set(callId, { title: held?.title ?? title, kind: held?.kind ?? kind });
      return [];
    }
    const held = this.pendingStarts.get(callId);
    this.pendingStarts.delete(callId);
    this.emittedStartedToolCallIds.add(callId);
    return [this.toolCallStartedDescriptor(msg, callId, held?.title ?? title, held?.kind ?? kind, rawInput, locations)];
  }

  private hasArguments(rawInput: unknown, locations: ACPToolCallLocation[] | null | undefined): boolean {
    if (this.firstLocationPath(locations)) return true;
    if (rawInput === null || rawInput === undefined) return false;
    if (typeof rawInput === 'object') return Object.keys(rawInput as object).length > 0;
    return true;
  }

  private async parseToolCallUpdate(
    msg: RawMessage,
    update: ACPSessionUpdate,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!callId) return [];

    const status = typeof update.status === 'string' ? update.status : '';
    const isTerminal = status === 'completed' || status === 'failed';
    const locations = update.locations as ACPToolCallLocation[] | null | undefined;
    const descriptors: CanonicalEventDescriptor[] = [];

    const held = this.pendingStarts.get(callId);
    if (held) {
      // The start was held for its arguments: release it on the first update
      // that carries them, or with the terminal update if none ever did.
      if (this.hasArguments(update.rawInput, locations) || isTerminal) {
        this.pendingStarts.delete(callId);
        this.emittedStartedToolCallIds.add(callId);
        descriptors.push(this.toolCallStartedDescriptor(msg, callId, held.title, held.kind, update.rawInput, locations));
      }
    } else if (
      !isTerminal
      && this.hasArguments(update.rawInput, locations)
      && !this.emittedStartedToolCallIds.has(callId)
      && !context.hasToolCall(callId)
      && (await context.findByProviderToolCallId(callId)) === null
    ) {
      // The tool_call row was processed by an earlier batch that held the
      // start and then ended. Nothing canonical exists for the call, so this
      // argument-carrying update is the first chance to write the card.
      this.emittedStartedToolCallIds.add(callId);
      descriptors.push(this.toolCallStartedDescriptor(msg, callId, update.title, update.kind, update.rawInput, locations));
    }

    if (!isTerminal) {
      return descriptors;
    }

    const isError = status === 'failed';
    descriptors.push({
      type: 'tool_call_completed',
      providerToolCallId: callId,
      status: isError ? 'error' : 'completed',
      result: this.extractResultText(update),
      isError,
    });
    return descriptors;
  }

  private parseRequestPermission(
    msg: RawMessage,
    event: KimiACPRawEvent,
    context: ParseContext,
  ): CanonicalEventDescriptor[] {
    const toolCall = event.request?.toolCall;
    if (!toolCall) return [];

    const callId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '';
    if (!callId) return [];

    return this.startOrHold(msg, context, callId, toolCall.title, toolCall.kind, toolCall.rawInput, toolCall.locations);
  }

  // ---------------------------------------------------------------------------
  // Helpers -- mirror KimiACPProtocol so canonical events carry the same tool
  // identifiers and arguments as the live-streamed events.
  // ---------------------------------------------------------------------------

  private toolCallStartedDescriptor(
    msg: RawMessage,
    callId: string,
    title: string | undefined,
    kind: string | undefined,
    rawInput: unknown,
    locations: ACPToolCallLocation[] | null | undefined,
  ): CanonicalEventDescriptor {
    const toolName = this.deriveToolName(title ?? 'Tool call', kind);
    const rawLocationPath = this.firstLocationPath(locations);
    // kimi spells absolute paths with forward slashes on every platform.
    const locationPath = rawLocationPath ? path.normalize(rawLocationPath) : null;
    const args = this.mergeLocationPath(this.normalizeArguments(rawInput), locationPath);
    const targetFilePath = this.extractTargetFilePath(args) ?? locationPath;
    const { mcpServer, mcpTool } = this.extractMcpMetadata(toolName);

    return {
      type: 'tool_call_started',
      toolName,
      toolDisplayName: this.toolDisplayName(toolName),
      arguments: args,
      targetFilePath,
      mcpServer,
      mcpTool,
      providerToolCallId: callId,
      createdAt: msg.createdAt,
    };
  }

  /**
   * Mirrors KimiACPProtocol.deriveToolName: `acp_fs.*` and `server/tool`
   * titles are normalized; everything else is already the tool's name.
   */
  private deriveToolName(title: string, _kind?: string | null): string {
    const cleaned = title.trim().replace(/^Tool:\s*/i, '');

    const match = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)/.exec(cleaned);
    if (match) {
      const [, serverName, toolName] = match;
      if (serverName === 'acp_fs') {
        switch (toolName) {
          case 'read_text_file':
            return 'Read';
          case 'write_text_file':
            return 'Write';
          case 'edit_text_file':
          case 'multi_edit_text_file':
            return 'Edit';
          default:
            return toolName;
        }
      }
      return `mcp__${serverName}__${toolName}`;
    }

    // Kimi's tool_call titles already name the tool; the title is the name.
    return cleaned || title || 'Tool call';
  }

  private toolDisplayName(toolName: string): string {
    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.tool;
    return toolName;
  }

  private extractMcpMetadata(toolName: string): { mcpServer: string | null; mcpTool: string | null } {
    if (!toolName.startsWith('mcp__')) {
      return { mcpServer: null, mcpTool: null };
    }
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      return { mcpServer: null, mcpTool: null };
    }
    return { mcpServer: parsed.server, mcpTool: parsed.tool };
  }

  private extractTargetFilePath(args: Record<string, unknown>): string | null {
    if (typeof args.file_path === 'string') return args.file_path;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.filePath === 'string') return args.filePath;
    return null;
  }

  /**
   * Pull the first non-empty `locations[]` path so the tracking pipeline
   * (which only reads args) can attribute the edit when the tool's rawInput
   * carries no path of its own.
   */
  private firstLocationPath(locations: ACPToolCallLocation[] | null | undefined): string | null {
    if (!Array.isArray(locations)) return null;
    for (const loc of locations) {
      if (loc && typeof loc.path === 'string' && loc.path.length > 0) {
        return loc.path;
      }
    }
    return null;
  }

  private mergeLocationPath(
    args: Record<string, unknown>,
    locationPath: string | null,
  ): Record<string, unknown> {
    if (!locationPath) return args;
    for (const key of ['path', 'file_path', 'filePath'] as const) {
      const value = args[key];
      if (typeof value !== 'string') continue;
      // kimi's rawInput path is relative to the session cwd; the absolute
      // locations[] path is what targetFilePath must carry.
      return path.isAbsolute(value) ? args : { ...args, [key]: locationPath };
    }
    return { ...args, path: locationPath };
  }

  private normalizeArguments(rawInput: unknown): Record<string, unknown> {
    if (!rawInput) return {};
    if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      const obj = rawInput as Record<string, unknown>;
      // ACP wraps MCP tool calls as `{ server, tool, arguments }`. Unwrap so
      // canonical events match what custom widgets expect.
      if (
        typeof obj.server === 'string' &&
        typeof obj.tool === 'string' &&
        obj.arguments &&
        typeof obj.arguments === 'object' &&
        !Array.isArray(obj.arguments)
      ) {
        return obj.arguments as Record<string, unknown>;
      }
      return obj;
    }
    return { value: rawInput };
  }

  private extractResultText(update: ACPSessionUpdate): string {
    // Prefer rawOutput; fall back to extracting text from the content array.
    if (update.rawOutput !== undefined) {
      return typeof update.rawOutput === 'string'
        ? update.rawOutput
        : JSON.stringify(update.rawOutput);
    }

    const content = update.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content) && content.length > 0) {
      const parts: string[] = [];
      for (const entry of content) {
        if (!entry || typeof entry !== 'object') continue;
        const t = entry.type;
        if (t === 'content') {
          const inner = entry.content as { type?: string; text?: string; uri?: string } | undefined;
          if (inner?.type === 'text' && typeof inner.text === 'string') {
            parts.push(inner.text);
          } else if (inner?.type === 'resource_link' && typeof inner.uri === 'string') {
            parts.push(inner.uri);
          }
        } else if (t === 'diff') {
          const diff = entry as { path?: unknown; oldText?: unknown; newText?: unknown };
          parts.push(JSON.stringify({
            type: 'diff',
            path: diff.path,
            oldText: diff.oldText,
            newText: diff.newText,
          }));
        }
      }
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }

    return '';
  }
}
