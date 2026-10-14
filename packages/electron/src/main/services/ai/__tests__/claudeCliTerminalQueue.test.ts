// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  canTypeIntoCliQueue,
  cliShowsQueuedMessages,
  matchCliQueueEntries,
  readCliTerminalQueueMarker,
  splitJsonlChunk,
} from '../claudeCliTerminalQueue';

// Screens and jsonl entries below are copied from the 07 probe logs (CLI 2.1.296).
const RULE = '─'.repeat(120);
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const busy = (...input: string[]) => ['', '✻ Perambulating… (34s · ↓ 117 tokens)', '', RULE, ...input, RULE, FOOTER];

describe('canTypeIntoCliQueue', () => {
  it('types into an empty input box, and into one already holding queued messages', () => {
    expect(canTypeIntoCliQueue(busy('❯ '))).toBe(true);
    expect(canTypeIntoCliQueue(busy('❯ Press up to edit queued messages'))).toBe(true);
    expect(cliShowsQueuedMessages(busy('❯ Press up to edit queued messages'))).toBe(true);
    expect(cliShowsQueuedMessages(busy('❯ '))).toBe(false);
  });

  it('holds while the user has text in the box, a dialog is open, or no input box is drawn', () => {
    expect(canTypeIntoCliQueue(busy('❯ QUEUED-THREE line1', '  line2 multi-line', '  line3'))).toBe(false);
    expect(canTypeIntoCliQueue([
      '', ' Do you want to proceed?', RULE, '❯ 1. Yes', '  2. No', RULE, ' Esc to cancel · Enter to select',
    ])).toBe(false);
    expect(canTypeIntoCliQueue(['', '✻ Perambulating…', ' Which option?', '❯ 1. Alpha', '  2. Beta'])).toBe(false);
    expect(canTypeIntoCliQueue(null)).toBe(false);
  });
});

describe('matchCliQueueEntries', () => {
  const rows = [
    { id: 'q1', typedText: 'QUEUED-ONE reply with the word alpha only', typedAt: 1 },
    { id: 'q2', typedText: 'QUEUED-TWO reply with the word beta only', typedAt: 2 },
    { id: 'q3', typedText: 'QUEUED-THREE line1\r\nline2 multi-line\nline3', typedAt: 3 },
  ];

  it('absorbed mid-turn: enqueue then remove with reason absorbed_mid_turn', () => {
    const entries = [
      { type: 'queue-operation', operation: 'enqueue', content: 'QUEUED-ONE reply with the word alpha only' },
      { type: 'queue-operation', operation: 'enqueue', content: 'QUEUED-THREE line1\nline2 multi-line\nline3' },
      { type: 'queue-operation', operation: 'remove', content: 'QUEUED-ONE reply with the word alpha only', reason: 'absorbed_mid_turn', commandUuid: 'c1' },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'QUEUED-ONE reply with the word alpha only', source_uuid: 'c1' } },
    ];
    expect(matchCliQueueEntries(entries, rows)).toEqual({ queued: ['q1', 'q3'], consumed: ['q1'] });
  });

  it('dequeued as a new turn, or taken at once with no queue operation', () => {
    const dequeued = [
      { type: 'queue-operation', operation: 'enqueue', content: 'QUEUED-TWO reply with the word beta only' },
      { type: 'queue-operation', operation: 'dequeue' },
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'QUEUED-TWO reply with the word beta only' } },
    ];
    expect(matchCliQueueEntries(dequeued, rows).consumed).toEqual(['q2']);
    const direct = [{ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'QUEUED-ONE reply with the word alpha only' } }];
    expect(matchCliQueueEntries(direct, rows)).toEqual({ queued: [], consumed: ['q1'] });
  });

  it('ignores task notifications, tool results and other dequeued text, and takes duplicates oldest first', () => {
    const entries = [
      { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>QUEUED-ONE</task-notification>' },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'QUEUED-ONE reply with the word alpha only' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'QUEUED-ONE reply with the word alpha only' }] } },
      { type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'same' }] } },
    ];
    const dupes = [
      { id: 'late', typedText: 'same', typedAt: 9 },
      { id: 'early', typedText: 'same', typedAt: 5 },
    ];
    expect(matchCliQueueEntries(entries, [...rows, ...dupes]).consumed).toEqual(['early']);
  });
});

describe('splitJsonlChunk', () => {
  it('only uses complete lines and counts their bytes', () => {
    const chunk = '{"type":"user","message":{"content":"é"}}\n{"type":"queue-op';
    const { entries, consumedBytes } = splitJsonlChunk(chunk);
    expect(entries).toHaveLength(1);
    expect(consumedBytes).toBe(Buffer.byteLength('{"type":"user","message":{"content":"é"}}\n', 'utf8'));
  });
});

describe('readCliTerminalQueueMarker', () => {
  it('reads a marker and rejects a malformed one', () => {
    const marker = { typedAt: 1, typedText: 'x', jsonlPath: '/p.jsonl', jsonlOffset: 10 };
    expect(readCliTerminalQueueMarker({ cliTerminalQueue: marker })).toEqual(marker);
    expect(readCliTerminalQueueMarker({ cliTerminalQueue: { typedText: 'x' } })).toBeNull();
    expect(readCliTerminalQueueMarker(undefined)).toBeNull();
  });
});
