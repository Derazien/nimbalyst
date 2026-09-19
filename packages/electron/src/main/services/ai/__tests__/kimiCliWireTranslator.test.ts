// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { KimiACPRawParser } from '@nimbalyst/runtime/ai/server/transcript/parsers/KimiACPRawParser';
import type { ParseContext } from '@nimbalyst/runtime/ai/server/transcript/parsers/IRawMessageParser';
import { KimiCliWireTranslator, type KimiWireAction } from '../kimiCliWireTranslator';

// Lines written by kimi 0.43.1 on this machine (paths scrubbed to C:/ws): an
// approved Write turn, a Ctrl-C cancelled turn and a quota-failed turn.
const FIXTURE = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'kimi-wire-0.43.1.jsonl'), 'utf8')
  .split('\n');

function translateAll(lines: string[]): KimiWireAction[] {
  const translator = new KimiCliWireTranslator();
  return lines.flatMap((line) => translator.translateLine(line));
}

const context: ParseContext = {
  sessionId: 's1',
  hasToolCall: () => false,
  hasSubagent: () => false,
  findByProviderToolCallId: async () => null,
  findActiveToolCallByRawProviderId: async () => null,
};

async function transcriptOf(actions: KimiWireAction[]) {
  const parser = new KimiACPRawParser();
  const out = [];
  let id = 0;
  for (const action of actions) {
    if (action.kind !== 'row') continue;
    out.push(...(await parser.parseMessage({
      id: ++id,
      sessionId: 's1',
      source: 'kimi-code-cli',
      direction: action.direction,
      content: action.content,
      createdAt: action.createdAt,
      metadata: action.metadata,
    }, context)));
  }
  return out;
}

describe('KimiCliWireTranslator', () => {
  it('derives running / waiting / idle from a real wire log, one idle per turn', () => {
    const states = translateAll(FIXTURE)
      .filter((a): a is Extract<KimiWireAction, { kind: 'turn-state' }> => a.kind === 'turn-state')
      .map((a) => `${a.state}${a.endReason ? `:${a.endReason}` : ''}`);
    expect(states).toEqual([
      'running',
      'waiting_for_input',
      'running',
      'idle:completed',
      'running',
      'idle:cancelled',
      'idle:failed',
    ]);
  });

  it('produces rows the existing Kimi parser turns into the real conversation', async () => {
    const events = await transcriptOf(translateAll(FIXTURE));
    const summary = events.map((e) => {
      switch (e.type) {
        case 'user_message': return `user:${e.text}`;
        case 'assistant_message': return `assistant:${e.text}`;
        case 'tool_call_started': return `tool:${e.toolName}:${e.targetFilePath}`;
        case 'tool_call_completed': return `result:${e.result}`;
        case 'system_message': return `${e.systemType}:${e.text.slice(0, 40)}`;
        default: return e.type;
      }
    });
    expect(summary).toEqual([
      "user:Create a file named kimi-live-probe.txt containing exactly 'kimi live ok', then reply with the single word: done",
      `tool:Write:${path.normalize('C:/ws/kimi-live-probe.txt')}`,
      'result:Wrote 12 bytes to kimi-live-probe.txt',
      'assistant:done',
      'user:Write the numbers 1 to 300 as English words, one per line. No tools.',
      "error:403 You've reached your 5-hour usage lim",
    ]);
  });

  it('keeps assistant text and tool calls in the order kimi produced them', async () => {
    const translator = new KimiCliWireTranslator();
    const loop = (event: Record<string, unknown>) =>
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time: 1 });
    const lines = [
      loop({ type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'Let me look.' } }),
      loop({ type: 'tool.call', toolCallId: 't1', name: 'Bash', args: { command: 'ls' } }),
      loop({ type: 'tool.result', toolCallId: 't1', result: { isError: true, output: 'boom' } }),
      loop({ type: 'step.end', turnId: '0', step: 1 }),
      loop({ type: 'content.part', turnId: '0', step: 2, part: { type: 'text', text: 'It failed.' } }),
      JSON.stringify({ type: 'turn.step.interrupted', turnId: 0, step: 2, reason: 'aborted', time: 2 }),
    ];
    const events = await transcriptOf(lines.flatMap((l) => translator.translateLine(l)));
    expect(events.map((e) => e.type === 'tool_call_completed' ? `${e.type}:${e.isError}` : e.type)).toEqual([
      'assistant_message',
      'tool_call_started',
      'tool_call_completed:true',
      'assistant_message',
    ]);
  });

  it('logs a prompt typed while a turn runs, and never an injected reminder', async () => {
    const translator = new KimiCliWireTranslator();
    const rows = [
      JSON.stringify({ type: 'turn.steer', input: [{ type: 'text', text: 'also do B' }], origin: { kind: 'user' }, time: 5 }),
      JSON.stringify({ type: 'turn.steer', input: [{ type: 'text', text: 'Skill loaded' }], origin: { kind: 'model' }, time: 6 }),
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'wake up' }], origin: { kind: 'injection' }, time: 7 }),
    ].flatMap((l) => translator.translateLine(l));
    expect((await transcriptOf(rows)).map((e) => e.type === 'user_message' ? e.text : e.type)).toEqual(['also do B']);
  });

  it('ignores blank, partial, non-JSON and unknown lines without throwing', () => {
    const translator = new KimiCliWireTranslator();
    for (const line of ['', '   ', '{"type":"agent.tu', 'not json', '42', 'null', '{"type":"some.future.kind","x":1}']) {
      expect(translator.translateLine(line)).toEqual([]);
    }
  });
});
