// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KimiCliSessionRuntime } from '../kimiCliSessionRuntime';

let dir: string;
let index: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-runtime-'));
  index = path.join(dir, 'session_index.jsonl');
  fs.writeFileSync(index, '');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeSession(id: string, workDir: string, lines: string[]): string {
  const sessionDir = path.join(dir, 'sessions', id);
  fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), lines.map((l) => l + '\n').join(''));
  fs.appendFileSync(index, JSON.stringify({ sessionId: id, sessionDir: sessionDir.replace(/\\/g, '/'), workDir }) + '\n');
  return sessionDir;
}

const started = (turnId: number) => JSON.stringify({ turnId, type: 'agent.turn.started', time: 1 });
const prompt = (text: string) => JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 2 });
const ended = (turnId: number) => JSON.stringify({ turnId, outcome: 'done', type: 'agent.turn.ended', time: 3 });

function harness(opts: { resume?: { kimiSessionId: string; sessionDir: string }; claimed?: string[] } = {}) {
  const log: string[] = [];
  const runtime = new KimiCliSessionRuntime({
    workDir: 'C:/ws',
    indexPath: index,
    resume: opts.resume,
    isClaimed: (id) => (opts.claimed ?? []).includes(id),
    onKimiSessionId: (id) => log.push(`id:${id}`),
    onTurnState: (state, reason) => log.push(`state:${state}${reason ? `:${reason}` : ''}`),
    onRow: (row) => log.push(`row:${row.direction}:${row.content}`),
    onNeedsAttention: (why) => log.push(`attention:${why}`),
  });
  return { runtime, log };
}

describe('KimiCliSessionRuntime', () => {
  it('is idle once kimi draws its prompt box, and asks for attention on the trust picker', () => {
    const { runtime, log } = harness();
    runtime.start();
    expect(runtime.getTurnState()).toBeNull();
    runtime.noteTerminalOutput('\x1b[1m  Trust this folder?\x1b[0m\r\n   ❯ Trust this folder');
    expect(runtime.getTurnState()).toBeNull();
    runtime.noteTerminalOutput(' K3 thinking: high  C:\\ws \r\n\x1b[2mcontext:\x1b[0m 0% (0/1M)');
    expect(runtime.getTurnState()).toBe('idle');
    expect(log).toEqual(['attention:trust', 'state:idle']);
    runtime.stop();
  });

  it('reads the thinking effort and the open effort picker off the terminal, where kimi shows them before any session exists', () => {
    // Screen text as kimi 2.0.2 drew it (recorded 2026-09-21).
    const { runtime } = harness();
    runtime.start();
    runtime.noteTerminalOutput(' Ask When Needed  K3-256k thinking: high  C:\\ws\r\ncontext: 0% (0/256k) ');
    expect(runtime.getThinkingEffort()).toBe('high');
    expect(runtime.getEffortPickerLevels()).toBeNull();

    runtime.noteTerminalOutput('\r\n  Select thinking effort\r\n  \u2190\u2192 switch \u00b7 Enter select \u00b7 Alt+S session-only \u00b7 Esc cancel\r\n\r\n     Low    [ High ]    Max\r\n');
    expect(runtime.getEffortPickerLevels()).toEqual(['low', 'high', 'max']);

    runtime.noteTerminalOutput('\r\n   Thinking set to max for this session only.\r\n \u2502 >  \u2502 \r\n Ask When Needed  K3-256k thinking: max  C:\\ws\r\ncontext: 0% (0/256k) ');
    expect(runtime.getThinkingEffort()).toBe('max');
    // The picker is gone once kimi is back at its prompt.
    expect(runtime.getEffortPickerLevels()).toBeNull();
    runtime.stop();
  });

  it('takes the thinking effort from the event log once the session has one', () => {
    const { runtime } = harness();
    runtime.start();
    runtime.noteTerminalOutput(' K3 thinking: high  C:\\ws \r\ncontext: 0% (0/1M)');
    makeSession('session_mine', 'C:/ws', [
      JSON.stringify({ type: 'profile.bind', modelAlias: 'kimi-code/k3', thinkingEffort: 'high', time: 1 }),
      JSON.stringify({ type: 'config.update', thinkingEffort: 'low', time: 2 }),
    ]);
    runtime.poll();
    expect(runtime.getThinkingEffort()).toBe('low');
    runtime.stop();
  });

  it('finds the session kimi creates on the first prompt, claims it, and follows it from the start', () => {
    makeSession('session_before', 'C:/ws', [started(0)]);
    const { runtime, log } = harness({ claimed: ['session_taken'] });
    runtime.start();
    runtime.poll();
    expect(runtime.kimiSessionId).toBeNull();

    makeSession('session_taken', 'C:/ws', [started(0)]);
    makeSession('session_mine', 'C:/ws', [started(0), prompt('hi')]);
    runtime.poll();
    expect(runtime.kimiSessionId).toBe('session_mine');
    expect(runtime.getTurnState()).toBe('running');

    fs.appendFileSync(path.join(dir, 'sessions', 'session_mine', 'agents', 'main', 'wire.jsonl'), ended(0) + '\n');
    runtime.poll();
    expect(log).toEqual(['id:session_mine', 'state:running', 'row:input:hi', 'state:idle:completed']);
    runtime.stop();
  });

  it('on resume follows only what kimi writes from now on', () => {
    const sessionDir = makeSession('session_r', 'C:/ws', [started(0), prompt('old'), ended(0)]);
    const { runtime, log } = harness({ resume: { kimiSessionId: 'session_r', sessionDir } });
    runtime.start();
    expect(runtime.kimiSessionId).toBe('session_r');
    fs.appendFileSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), started(1) + '\n' + prompt('new') + '\n');
    runtime.poll();
    expect(log).toEqual(['state:running', 'row:input:new']);
    runtime.stop();
  });
});
