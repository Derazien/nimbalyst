// @vitest-environment node
/**
 * Contract tests for KimiACPRawParser.
 *
 * Verifies that representative raw messages (the shapes KimiACPProtocol stores
 * via KimiCodeProvider.storeRawEventIfPresent, plus the turn-final
 * item.completed synthesis) produce the expected canonical event descriptors.
 */

import { describe, it, expect } from 'vitest';
import { KimiACPRawParser } from '../parsers/KimiACPRawParser';
import type { ParseContext } from '../parsers/IRawMessageParser';
import type { RawMessage } from '../TranscriptTransformer';

const SESSION_ID = 'test-session';

function makeRawMessage(overrides: Partial<RawMessage>): RawMessage {
  return {
    id: 1,
    sessionId: SESSION_ID,
    source: 'kimi-code',
    direction: 'output',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ParseContext>): ParseContext {
  return {
    sessionId: SESSION_ID,
    hasToolCall: () => false,
    hasSubagent: () => false,
    findByProviderToolCallId: async () => null,
    findActiveToolCallByRawProviderId: async () => null,
    ...overrides,
  };
}

function sessionUpdateRow(update: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'session/update',
    sessionId: 'kimi-acp-session-1',
    update,
  });
}

describe('KimiACPRawParser', () => {
  describe('input messages', () => {
    it('parses plain text input as user_message', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({ direction: 'input', content: 'Hello Kimi' });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'user_message',
        text: 'Hello Kimi',
        mode: 'agent',
      });
    });

    it('uses mode from metadata', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: 'Plan this feature',
        metadata: { mode: 'planning' },
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({ type: 'user_message', mode: 'planning' });
    });

    it('detects system reminder messages', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        direction: 'input',
        content: '<SYSTEM_REMINDER>You are a helpful assistant</SYSTEM_REMINDER>',
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({ type: 'system_message', systemType: 'status' });
    });

    it('skips empty input', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({ direction: 'input', content: '   ' });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('item.completed messages', () => {
    it('parses assistant response from item.completed format', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello! How can I help?' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Hello! How can I help?',
      });
    });

    it('concatenates multiple output_text parts', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Part one. ' },
              { type: 'output_text', text: 'Part two.' },
            ],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Part one. Part two.',
      });
    });

    it('skips item.completed with non-assistant role or empty text', async () => {
      const parser = new KimiACPRawParser();
      const systemMsg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', role: 'system', content: [{ type: 'output_text', text: 'x' }] },
        }),
      });
      const emptyMsg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
        }),
      });

      expect(await parser.parseMessage(systemMsg, makeContext())).toHaveLength(0);
      expect(await parser.parseMessage(emptyMsg, makeContext())).toHaveLength(0);
    });
  });

  describe('session/update notifications', () => {
    it('skips agent_message_chunk text rows (item.completed carries the full text)', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('skips agent_thought_chunk rows', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Let me think...' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('parses tool_call updates with rawInput into tool_call_started', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Write',
          kind: 'edit',
          status: 'pending',
          rawInput: { file_path: 'D:\\work\\project\\hello.txt', content: 'hello' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Write',
        providerToolCallId: 'tc-1',
        arguments: { file_path: 'D:\\work\\project\\hello.txt', content: 'hello' },
        targetFilePath: 'D:\\work\\project\\hello.txt',
      });
    });

    it('fills the path from locations[] when rawInput carries none', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-2',
          title: 'Edit',
          kind: 'edit',
          rawInput: { old_string: 'a', new_string: 'b' },
          locations: [{ path: 'D:\\work\\project\\app.ts' }],
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Edit',
        arguments: { old_string: 'a', new_string: 'b', path: 'D:\\work\\project\\app.ts' },
        targetFilePath: 'D:\\work\\project\\app.ts',
      });
    });

    it('unwraps MCP-wrapped tool calls and extracts mcp metadata', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-3',
          title: 'nimbalyst.database_query',
          rawInput: { server: 'nimbalyst', tool: 'database_query', arguments: { query: 'select 1' } },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'mcp__nimbalyst__database_query',
        toolDisplayName: 'database_query',
        mcpServer: 'nimbalyst',
        mcpTool: 'database_query',
        arguments: { query: 'select 1' },
      });
    });

    it('dedupes a repeated tool_call for the same call id', async () => {
      const parser = new KimiACPRawParser();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-4',
        title: 'Read',
        rawInput: { file_path: 'D:\\work\\project\\a.ts' },
      };
      const first = makeRawMessage({ content: sessionUpdateRow(update) });
      const second = makeRawMessage({ content: sessionUpdateRow(update) });

      expect(await parser.parseMessage(first, makeContext())).toHaveLength(1);
      expect(await parser.parseMessage(second, makeContext())).toHaveLength(0);
    });

    it('parses tool_call_update completed into tool_call_completed', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          rawOutput: 'file written',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'tc-1',
        status: 'completed',
        result: 'file written',
        isError: false,
      });
    });

    it('marks failed tool_call_update rows as errors', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-5',
          status: 'failed',
          rawOutput: { error: 'permission denied' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_completed',
        providerToolCallId: 'tc-5',
        status: 'error',
        isError: true,
      });
    });

    it('skips in_progress tool_call_update rows', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'in_progress',
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('skips usage_update rows', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({
          sessionUpdate: 'usage_update',
          used: 12000,
          size: 262144,
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('skips unknown sessionUpdate types gracefully', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: sessionUpdateRow({ sessionUpdate: 'some_future_type', content: {} }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('session/request_permission rows', () => {
    it('creates a tool_call_started when the permission row is the first sight of the call', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'session/request_permission',
          sessionId: 'kimi-acp-session-1',
          request: {
            toolCall: {
              toolCallId: 'tc-9',
              title: 'Write',
              kind: 'edit',
              rawInput: { file_path: 'D:\\work\\project\\hello.txt' },
            },
            options: [{ optionId: 'approve_once' }],
          },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Write',
        providerToolCallId: 'tc-9',
      });
    });

    it('does not duplicate a tool_call_started already emitted for the call', async () => {
      const parser = new KimiACPRawParser();
      const permissionMsg = makeRawMessage({
        content: JSON.stringify({
          type: 'session/request_permission',
          sessionId: 'kimi-acp-session-1',
          request: {
            toolCall: { toolCallId: 'tc-9', title: 'Write', rawInput: {} },
            options: [],
          },
        }),
      });

      expect(await parser.parseMessage(permissionMsg, makeContext())).toHaveLength(1);
      expect(await parser.parseMessage(permissionMsg, makeContext())).toHaveLength(0);
    });

    it('skips request_permission_preview rows', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'session/request_permission_preview',
          sessionId: 'kimi-acp-session-1',
          toolCall: { toolCallId: 'tc-10', title: 'Write' },
        }),
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });
  });

  describe('plain text output and edge cases', () => {
    it('treats non-JSON output as assistant_message', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({ content: 'Plain text response from Kimi' });

      const descriptors = await parser.parseMessage(msg, makeContext());

      expect(descriptors[0]).toMatchObject({
        type: 'assistant_message',
        text: 'Plain text response from Kimi',
      });
    });

    it('skips hidden messages', async () => {
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hidden' }] },
        }),
        hidden: true,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors).toHaveLength(0);
    });

    it('preserves createdAt from raw message', async () => {
      const timestamp = new Date('2026-03-15T10:30:00Z');
      const parser = new KimiACPRawParser();
      const msg = makeRawMessage({
        content: JSON.stringify({
          type: 'item.completed',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'With timestamp' }] },
        }),
        createdAt: timestamp,
      });

      const descriptors = await parser.parseMessage(msg, makeContext());
      expect(descriptors[0]).toMatchObject({ createdAt: timestamp });
    });
  });
});
