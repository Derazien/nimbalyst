// @vitest-environment node
/**
 * Contract tests for KimiACPRawParser.
 *
 * Verifies that representative raw messages (the shapes KimiACPProtocol stores
 * via KimiCodeProvider.storeRawEventIfPresent, plus the turn-final
 * item.completed synthesis) produce the expected canonical event descriptors.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
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

// Recorded from a real `kimi acp` 0.43.1 turn on 2026-09-17: the first
// tool_call has no arguments, two argument-less in_progress updates and
// the permission request follow, then one in_progress update finally
// carries rawInput (relative path) and locations (absolute path).
const REAL_WRITE_ORDER = [
  { sessionUpdate: 'tool_call', toolCallId: '0:tool_w', title: 'Write', kind: 'edit', status: 'pending', content: [] },
  { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_w', status: 'in_progress', content: [] },
  { sessionUpdate: 'tool_call_update', toolCallId: '0:tool_w', status: 'in_progress', content: [] },
  {
    sessionUpdate: 'tool_call_update', toolCallId: '0:tool_w', title: 'Writing new.txt', kind: 'edit', status: 'in_progress',
    rawInput: { path: 'new.txt', content: 'hello' }, locations: [{ path: 'C:/ws/new.txt' }], content: [],
  },
  {
    sessionUpdate: 'tool_call_update', toolCallId: '0:tool_w', status: 'completed',
    rawOutput: 'Wrote 5 bytes to new.txt', locations: [{ path: 'C:/ws/new.txt' }], content: [],
  },
];

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


    it('holds tool_call_started until the update that carries the arguments (real kimi order)', async () => {
      const parser = new KimiACPRawParser();
      const seen = new Set<string>();
      const context = makeContext({ hasToolCall: (id) => seen.has(id) });
      const results: Array<Awaited<ReturnType<KimiACPRawParser['parseMessage']>>> = [];
      let id = 1;
      for (const update of REAL_WRITE_ORDER) {
        const descriptors = await parser.parseMessage(makeRawMessage({ id: id++, content: sessionUpdateRow(update) }), context);
        for (const d of descriptors) {
          if (d.type === 'tool_call_started' && d.providerToolCallId) seen.add(d.providerToolCallId);
        }
        results.push(descriptors);
      }

      // Nothing renders while the arguments are unknown.
      expect(results[0]).toHaveLength(0);
      expect(results[1]).toHaveLength(0);
      expect(results[2]).toHaveLength(0);
      // The argument-carrying update produces the one and only started card,
      // named after the original title, never the progress title.
      expect(results[3]).toHaveLength(1);
      expect(results[3][0]).toMatchObject({
        type: 'tool_call_started',
        toolName: 'Write',
        providerToolCallId: '0:tool_w',
        arguments: { content: 'hello' },
      });
      // The relative rawInput path is replaced by the absolute locations[]
      // path so targetFilePath resolves inside the workspace.
      expect(results[3][0]).toMatchObject({
        arguments: { path: path.normalize('C:/ws/new.txt') },
        targetFilePath: path.normalize('C:/ws/new.txt'),
      });
      expect(results[4]).toHaveLength(1);
      expect(results[4][0]).toMatchObject({ type: 'tool_call_completed', providerToolCallId: '0:tool_w', result: 'Wrote 5 bytes to new.txt' });
    });

    it('emits the held start together with the terminal update when no update ever carried arguments', async () => {
      const parser = new KimiACPRawParser();
      const first = await parser.parseMessage(makeRawMessage({
        content: sessionUpdateRow({ sessionUpdate: 'tool_call', toolCallId: '0:tool_r', title: 'Read', kind: 'read', status: 'pending' }),
      }), makeContext());
      expect(first).toHaveLength(0);

      const terminal = await parser.parseMessage(makeRawMessage({
        content: sessionUpdateRow({ sessionUpdate: 'tool_call_update', toolCallId: '0:tool_r', status: 'completed', rawOutput: '1\tline one' }),
      }), makeContext());
      expect(terminal.map((d) => d.type)).toEqual(['tool_call_started', 'tool_call_completed']);
      expect(terminal[0]).toMatchObject({ toolName: 'Read', providerToolCallId: '0:tool_r' });
    });

    it('recovers the start from an argument-carrying update when the tool_call row landed in an earlier batch', async () => {
      // A fresh parser (new batch) has no memory of the tool_call row, and the
      // canonical store has no event for the call either.
      const parser = new KimiACPRawParser();
      const descriptors = await parser.parseMessage(makeRawMessage({
        content: sessionUpdateRow(REAL_WRITE_ORDER[3]),
      }), makeContext());
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({ type: 'tool_call_started', providerToolCallId: '0:tool_w', arguments: { content: 'hello' } });
    });

    it('does not re-create a start that an earlier batch already wrote', async () => {
      const parser = new KimiACPRawParser();
      const descriptors = await parser.parseMessage(makeRawMessage({
        content: sessionUpdateRow(REAL_WRITE_ORDER[3]),
      }), makeContext({
        findByProviderToolCallId: async () => ({ id: 1 } as unknown as Awaited<ReturnType<ParseContext['findByProviderToolCallId']>>),
      }));
      expect(descriptors).toHaveLength(0);
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

    it('keeps waiting for the arguments when the permission row carries none (real kimi order)', async () => {
      const parser = new KimiACPRawParser();
      const seen = new Set<string>();
      const context = makeContext({ hasToolCall: (id) => seen.has(id) });
      const toolCall = await parser.parseMessage(makeRawMessage({ id: 1, content: sessionUpdateRow(REAL_WRITE_ORDER[0]) }), context);
      expect(toolCall).toHaveLength(0);

      const permission = await parser.parseMessage(makeRawMessage({
        id: 2,
        content: JSON.stringify({
          type: 'session/request_permission',
          sessionId: 'kimi-acp-session-1',
          request: {
            toolCall: { toolCallId: '0:tool_w', title: 'Write', kind: 'edit', status: 'pending' },
            options: [{ optionId: 'approve_once' }, { optionId: 'approve_always' }, { optionId: 'reject' }],
          },
        }),
      }), context);
      expect(permission).toHaveLength(0);

      const withArgs = await parser.parseMessage(makeRawMessage({ id: 3, content: sessionUpdateRow(REAL_WRITE_ORDER[3]) }), context);
      expect(withArgs).toHaveLength(1);
      expect(withArgs[0]).toMatchObject({ type: 'tool_call_started', toolName: 'Write', arguments: { content: 'hello' } });
    });

    it('does not duplicate a tool_call_started already emitted for the call', async () => {
      const parser = new KimiACPRawParser();
      const permissionMsg = makeRawMessage({
        content: JSON.stringify({
          type: 'session/request_permission',
          sessionId: 'kimi-acp-session-1',
          request: {
            toolCall: { toolCallId: 'tc-9', title: 'Write', rawInput: { file_path: 'D:\\work\\project\\hello.txt' } },
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
