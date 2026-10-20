/**
 * Translate OpenCode 2.x server events into the 1.x event shape.
 *
 * OpenCode 2.x replaced its HTTP API and its event vocabulary. Everything
 * downstream of the client -- the live protocol parser, OpenCodeRawParser that
 * rebuilds transcripts from persisted raw events, and the mobile sync whitelist
 * -- is written against 1.x `{ type, properties }` events. Translating at the
 * client keeps those consumers and every persisted row unchanged.
 *
 * The translator is stateful per event stream: tool names arrive on
 * `session.tool.input.started` while inputs arrive later on
 * `session.tool.called`, and each tool result must repeat both.
 *
 * Event shapes were taken from a live `opencode serve` 2.1.0.
 */

import * as path from 'path';
import type { OpenCodeSSEEvent } from '../../../protocols/OpenCodeSDKProtocol';

/** One decoded `data:` frame from `GET /api/event`. */
export interface OpenCodeV2Event {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string };
  data?: Record<string, unknown>;
}

interface ToolCallState {
  name: string;
  messageID: string;
  input: Record<string, unknown>;
}

export class OpenCodeV2EventTranslator {
  private readonly tools = new Map<string, ToolCallState>();
  private readonly reasoningText = new Map<string, string>();

  /**
   * @param fallbackDirectory - directory used to resolve relative edited-file
   *   paths when an event carries no `location`.
   */
  constructor(private readonly fallbackDirectory?: string) {}

  translate(event: OpenCodeV2Event): OpenCodeSSEEvent[] {
    const data = isRecord(event.data) ? event.data : {};
    const sessionID = stringField(data, 'sessionID');

    switch (event.type) {
      case 'server.connected':
        return [{ type: 'server.connected', properties: {} }];

      case 'session.step.started': {
        const messageID = stringField(data, 'assistantMessageID');
        if (!sessionID || !messageID) return [];
        return [messageUpdated(sessionID, messageID, data.model)];
      }

      case 'session.step.ended': {
        const messageID = stringField(data, 'assistantMessageID');
        if (!sessionID || !messageID) return [];
        return [
          messageUpdated(sessionID, messageID, undefined, {
            ...(isRecord(data.tokens) ? { tokens: data.tokens } : {}),
            ...(typeof data.finish === 'string' ? { finish: data.finish } : {}),
            ...(typeof data.cost === 'number' ? { cost: data.cost } : {}),
          }),
        ];
      }

      case 'session.text.delta': {
        const messageID = stringField(data, 'assistantMessageID');
        const delta = stringField(data, 'delta');
        if (!sessionID || !messageID || !delta) return [];
        return [
          {
            type: 'message.part.delta',
            properties: {
              sessionID,
              messageID,
              partID: `${messageID}-text-${ordinal(data)}`,
              field: 'text',
              delta,
            },
          },
        ];
      }

      case 'session.reasoning.delta': {
        const messageID = stringField(data, 'assistantMessageID');
        const delta = stringField(data, 'delta');
        if (!sessionID || !messageID || !delta) return [];
        const partID = `${messageID}-reasoning-${ordinal(data)}`;
        const text = (this.reasoningText.get(partID) ?? '') + delta;
        this.reasoningText.set(partID, text);
        return [
          {
            type: 'message.part.updated',
            properties: {
              part: { id: partID, sessionID, messageID, type: 'reasoning', text },
              delta,
            },
          },
        ];
      }

      case 'session.reasoning.ended': {
        const messageID = stringField(data, 'assistantMessageID');
        if (messageID) this.reasoningText.delete(`${messageID}-reasoning-${ordinal(data)}`);
        return [];
      }

      case 'session.tool.input.started': {
        const callID = stringField(data, 'id');
        const messageID = stringField(data, 'assistantMessageID');
        if (!callID) return [];
        this.tools.set(callID, {
          name: stringField(data, 'name') ?? 'unknown',
          messageID: messageID ?? '',
          input: {},
        });
        return [];
      }

      case 'session.tool.called': {
        const callID = stringField(data, 'id');
        if (!sessionID || !callID) return [];
        const tool = this.toolState(callID, data);
        tool.input = isRecord(data.input) ? data.input : {};
        return [toolPart(sessionID, callID, tool, { status: 'running', input: tool.input })];
      }

      case 'session.tool.success': {
        const callID = stringField(data, 'id');
        if (!sessionID || !callID) return [];
        const tool = this.toolState(callID, data);
        this.tools.delete(callID);
        const metadata = isRecord(data.metadata) ? data.metadata : {};
        const events: OpenCodeSSEEvent[] = [
          toolPart(sessionID, callID, tool, {
            status: 'completed',
            input: tool.input,
            output: joinTextContent(data.content),
            metadata,
          }),
        ];
        const directory = event.location?.directory ?? this.fallbackDirectory;
        for (const file of editedFiles(metadata)) {
          events.push({
            type: 'file.edited',
            properties: { sessionID, file: resolveEditedFile(file, directory) },
          });
        }
        return events;
      }

      case 'session.tool.failed': {
        const callID = stringField(data, 'id');
        if (!sessionID || !callID) return [];
        const tool = this.toolState(callID, data);
        this.tools.delete(callID);
        return [
          toolPart(sessionID, callID, tool, {
            status: 'error',
            input: tool.input,
            error: errorMessage(data.error) ?? 'Tool execution failed',
          }),
        ];
      }

      case 'permission.asked': {
        const id = stringField(data, 'id');
        const action = stringField(data, 'action');
        if (!sessionID || !id || !action) return [];
        const source = isRecord(data.source) ? data.source : {};
        const callID = stringField(source, 'id');
        return [
          {
            type: 'permission.asked',
            properties: {
              id,
              sessionID,
              permission: action,
              patterns: stringList(data.resources),
              always: stringList(data.save),
              metadata: {},
              ...(callID
                ? { tool: { messageID: stringField(source, 'messageID') ?? '', callID } }
                : {}),
            },
          },
        ];
      }

      case 'permission.replied': {
        const requestID = stringField(data, 'requestID');
        const reply = stringField(data, 'reply');
        if (!sessionID || !requestID || !reply) return [];
        return [
          {
            type: 'permission.replied',
            properties: { sessionID, permissionID: requestID, response: reply },
          },
        ];
      }

      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        if (!sessionID) return [];
        return [{ type: 'session.idle', properties: { sessionID } }];

      case 'session.execution.failed': {
        if (!sessionID) return [];
        const error = isRecord(data.error) ? data.error : {};
        return [
          {
            type: 'session.error',
            properties: {
              sessionID,
              error: {
                name: stringField(error, 'type') ?? 'UnknownError',
                message: errorMessage(error) ?? 'OpenCode turn failed',
                data: { message: errorMessage(error) ?? 'OpenCode turn failed' },
              },
            },
          },
          { type: 'session.idle', properties: { sessionID } },
        ];
      }

      default:
        // Inbox, instructions, usage, compaction, shell and catalog notices
        // have no 1.x consumer. The 2.x stream is also server-wide, so dropping
        // here keeps other sessions' noise out of the persisted raw log.
        return [];
    }
  }

  private toolState(callID: string, data: Record<string, unknown>): ToolCallState {
    const existing = this.tools.get(callID);
    if (existing) return existing;
    const created: ToolCallState = {
      name: stringField(data, 'name') ?? 'unknown',
      messageID: stringField(data, 'assistantMessageID') ?? '',
      input: {},
    };
    this.tools.set(callID, created);
    return created;
  }
}

/**
 * Parse one Server-Sent Events frame (the text between blank lines). Returns
 * null for comments such as `: heartbeat` and for undecodable payloads.
 */
export function parseOpenCodeV2SseFrame(frame: string): OpenCodeV2Event | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n'));
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
    return parsed as unknown as OpenCodeV2Event;
  } catch {
    return null;
  }
}

function messageUpdated(
  sessionID: string,
  messageID: string,
  model: unknown,
  extra: Record<string, unknown> = {},
): OpenCodeSSEEvent {
  const ref = isRecord(model) ? model : {};
  const providerID = stringField(ref, 'providerID');
  const modelID = stringField(ref, 'id');
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: 'assistant',
        ...(providerID && modelID ? { providerID, modelID } : {}),
        ...extra,
      },
    },
  };
}

function toolPart(
  sessionID: string,
  callID: string,
  tool: ToolCallState,
  state: Record<string, unknown>,
): OpenCodeSSEEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: callID,
        callID,
        sessionID,
        messageID: tool.messageID,
        type: 'tool',
        tool: tool.name,
        state,
      },
    },
  };
}

function editedFiles(metadata: Record<string, unknown>): string[] {
  if (!Array.isArray(metadata.files)) return [];
  return metadata.files
    .map((entry) => (isRecord(entry) ? stringField(entry, 'file') : undefined))
    .filter((file): file is string => !!file);
}

function resolveEditedFile(file: string, directory: string | undefined): string {
  if (path.isAbsolute(file) || !directory) return file;
  return path.join(directory, file);
}

function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => (isRecord(entry) && typeof entry.text === 'string' ? entry.text : ''))
    .join('');
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error || undefined;
  if (!isRecord(error)) return undefined;
  return stringField(error, 'message') ?? stringField(error, 'type');
}

function ordinal(data: Record<string, unknown>): number {
  return typeof data.ordinal === 'number' ? data.ordinal : 0;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
