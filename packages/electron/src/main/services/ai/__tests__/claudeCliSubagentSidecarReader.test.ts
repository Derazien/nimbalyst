// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  createClaudeCliSubagentSidecarReader,
  type SubagentSidecarFs,
} from '../claudeCliSubagentSidecarReader';

const DIR = '/proj/sess/subagents';

/** In-memory fs with real byte semantics, so offset maths is genuinely exercised. */
function fakeFs(files: Record<string, string>) {
  const calls: Array<{ op: string; path: string; start?: number; end?: number }> = [];
  const store = new Map<string, Buffer>();
  for (const [p, text] of Object.entries(files)) store.set(p, Buffer.from(text, 'utf8'));

  const fs: SubagentSidecarFs = {
    join: (...parts) => parts.join('/'),
    async listDir(dir) {
      calls.push({ op: 'listDir', path: dir });
      const prefix = `${dir}/`;
      return [...store.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
    },
    async fileSize(filePath) {
      const buf = store.get(filePath);
      return buf ? buf.length : null;
    },
    async readRange(filePath, start, end) {
      calls.push({ op: 'readRange', path: filePath, start, end });
      const buf = store.get(filePath);
      if (!buf) return '';
      return buf.subarray(start, end).toString('utf8');
    },
    async readTextFile(filePath) {
      const buf = store.get(filePath);
      return buf ? buf.toString('utf8') : null;
    },
  };

  return {
    fs,
    calls,
    write(path: string, text: string) { store.set(path, Buffer.from(text, 'utf8')); },
    append(path: string, text: string) {
      const prev = store.get(path) ?? Buffer.alloc(0);
      store.set(path, Buffer.concat([prev, Buffer.from(text, 'utf8')]));
    },
  };
}

const assistantRow = (agentId: string, messageId: string, extra = '') =>
  JSON.stringify({
    type: 'assistant', isSidechain: true, agentId,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: `hi${extra}` }] },
  }) + '\n';

const META = (meta: object) => JSON.stringify(meta);

describe('claudeCliSubagentSidecarReader', () => {
  it('builds an index from a sidecar directory', async () => {
    const { fs } = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ agentType: 'Explore', toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one') + assistantRow('a1', 'msg_two'),
    });
    const reader = createClaudeCliSubagentSidecarReader(fs);

    const index = await reader.refresh({ subagentsDir: DIR });

    expect(index.agentCount).toBe(1);
    expect(index.parentToolUseIdForMessageId('msg_one')).toBe('toolu_spawn1');
    expect(index.parentToolUseIdForMessageId('msg_two')).toBe('toolu_spawn1');
    expect(index.metaForAgentId('a1')?.agentType).toBe('Explore');
  });

  it('reads only appended bytes on a later refresh', async () => {
    // The reference session had a single 13.5MB agent file. Re-reading whole
    // files per refresh is what this offset exists to avoid.
    const harness = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one'),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    await reader.refresh({ subagentsDir: DIR });
    const firstRead = harness.calls.filter(c => c.op === 'readRange').at(-1)!;
    expect(firstRead.start).toBe(0);

    harness.append(`${DIR}/agent-a1.jsonl`, assistantRow('a1', 'msg_two'));
    const index = await reader.refresh({ subagentsDir: DIR });

    const secondRead = harness.calls.filter(c => c.op === 'readRange').at(-1)!;
    expect(secondRead.start).toBe(firstRead.end);
    expect(index.parentToolUseIdForMessageId('msg_two')).toBe('toolu_spawn1');
  });

  it('costs nothing but a size check when a file has not grown', async () => {
    const harness = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one'),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    await reader.refresh({ subagentsDir: DIR });
    const readsAfterFirst = harness.calls.filter(c => c.op === 'readRange').length;
    await reader.refresh({ subagentsDir: DIR });

    expect(harness.calls.filter(c => c.op === 'readRange').length).toBe(readsAfterFirst);
  });

  it('re-reads a partially written row intact instead of losing or mangling it', async () => {
    const full = assistantRow('a1', 'msg_two');
    const harness = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one') + full.slice(0, 40),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    const partial = await reader.refresh({ subagentsDir: DIR });
    expect(partial.parentToolUseIdForMessageId('msg_one')).toBe('toolu_spawn1');
    expect(partial.parentToolUseIdForMessageId('msg_two')).toBeUndefined();

    // The CLI finishes the append.
    harness.append(`${DIR}/agent-a1.jsonl`, full.slice(40));
    const complete = await reader.refresh({ subagentsDir: DIR });

    expect(complete.parentToolUseIdForMessageId('msg_two')).toBe('toolu_spawn1');
  });

  it('keeps byte offsets correct across multi-byte content', async () => {
    // A char-length offset would drift here and corrupt every later read.
    const harness = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one', ' ünïcøde ✅ 日本語'),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    await reader.refresh({ subagentsDir: DIR });
    harness.append(`${DIR}/agent-a1.jsonl`, assistantRow('a1', 'msg_two'));
    const index = await reader.refresh({ subagentsDir: DIR });

    expect(index.parentToolUseIdForMessageId('msg_two')).toBe('toolu_spawn1');
  });

  it('skips a malformed row without taking the index down', async () => {
    const { fs } = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: '{ not json\n' + assistantRow('a1', 'msg_two'),
    });
    const reader = createClaudeCliSubagentSidecarReader(fs);

    const index = await reader.refresh({ subagentsDir: DIR });

    expect(index.parentToolUseIdForMessageId('msg_two')).toBe('toolu_spawn1');
  });

  it('returns an empty index when the session has no sidecar directory', async () => {
    const { fs } = fakeFs({});
    const reader = createClaudeCliSubagentSidecarReader(fs);

    const index = await reader.refresh({ subagentsDir: DIR });

    expect(index.agentCount).toBe(0);
    expect(index.parentToolUseIdForMessageId('msg_one')).toBeUndefined();
  });

  it('picks up meta written after the transcript rows', async () => {
    // meta.json is written at spawn, but a refresh can still race it.
    const harness = fakeFs({
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one'),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    const before = await reader.refresh({ subagentsDir: DIR });
    expect(before.agentIdForMessageId('msg_one')).toBe('a1');
    expect(before.parentToolUseIdForMessageId('msg_one')).toBeUndefined();

    harness.write(`${DIR}/agent-a1.meta.json`, META({ toolUseId: 'toolu_spawn1' }));
    const after = await reader.refresh({ subagentsDir: DIR });

    expect(after.parentToolUseIdForMessageId('msg_one')).toBe('toolu_spawn1');
  });

  describe('waitForParentToolUseId', () => {
    it('resolves once the sidecar row lands mid-wait', async () => {
      const harness = fakeFs({
        [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
        [`${DIR}/agent-a1.jsonl`]: '',
      });
      const reader = createClaudeCliSubagentSidecarReader(harness.fs);

      let slept = 0;
      const sleep = async () => {
        slept++;
        if (slept === 2) harness.append(`${DIR}/agent-a1.jsonl`, assistantRow('a1', 'msg_late'));
      };

      const parent = await reader.waitForParentToolUseId({
        subagentsDir: DIR, messageId: 'msg_late', sleep, delayMs: 0,
      });

      expect(parent).toBe('toolu_spawn1');
      expect(slept).toBe(2);
    });

    it('gives up for a lead turn rather than blocking forever', async () => {
      const harness = fakeFs({
        [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
        [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_agent'),
      });
      const reader = createClaudeCliSubagentSidecarReader(harness.fs);

      let slept = 0;
      const parent = await reader.waitForParentToolUseId({
        subagentsDir: DIR, messageId: 'msg_lead', attempts: 3, delayMs: 0,
        sleep: async () => { slept++; },
      });

      expect(parent).toBeUndefined();
      expect(slept).toBe(2); // one sleep between each of the three attempts
    });

    it('stops early when the agent is known but its spawn has not been observed', async () => {
      // An in-process teammate carries no meta.toolUseId, so its spawn arrives on
      // the wire, not on disk. Re-reading the directory cannot help.
      const harness = fakeFs({
        [`${DIR}/agent-a1.meta.json`]: META({ name: 'atlas', teamName: 'session-x' }),
        [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_team'),
      });
      const reader = createClaudeCliSubagentSidecarReader(harness.fs);

      let slept = 0;
      const parent = await reader.waitForParentToolUseId({
        subagentsDir: DIR, messageId: 'msg_team', attempts: 5, delayMs: 0,
        sleep: async () => { slept++; },
      });

      expect(parent).toBeUndefined();
      expect(slept).toBe(0);
    });

    it('resolves a teammate once its spawn result is supplied', async () => {
      const harness = fakeFs({
        [`${DIR}/agent-a1.meta.json`]: META({ name: 'atlas', teamName: 'session-x' }),
        [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_team'),
      });
      const reader = createClaudeCliSubagentSidecarReader(harness.fs);

      const parent = await reader.waitForParentToolUseId({
        subagentsDir: DIR,
        messageId: 'msg_team',
        spawns: [{ toolUseId: 'toolu_team', resultText: 'agent_id: atlas@session-x' }],
        delayMs: 0,
      });

      expect(parent).toBe('toolu_team');
    });

    it('never attributes a lead message id that a fork also carries', async () => {
      const harness = fakeFs({
        [`${DIR}/agent-a1.meta.json`]: META({ agentType: 'fork', isFork: true, toolUseId: 'toolu_fork' }),
        [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_forkpoint') + assistantRow('a1', 'msg_forkown'),
      });
      const reader = createClaudeCliSubagentSidecarReader(harness.fs);

      const leadMessageIds = ['msg_forkpoint'];
      expect(await reader.waitForParentToolUseId({
        subagentsDir: DIR, messageId: 'msg_forkpoint', leadMessageIds, attempts: 2, delayMs: 0,
        sleep: async () => {},
      })).toBeUndefined();
      expect(await reader.waitForParentToolUseId({
        subagentsDir: DIR, messageId: 'msg_forkown', leadMessageIds, delayMs: 0,
      })).toBe('toolu_fork');
    });
  });

  it('clear() drops cached offsets so a fresh read starts from zero', async () => {
    const harness = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: META({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a1.jsonl`]: assistantRow('a1', 'msg_one'),
    });
    const reader = createClaudeCliSubagentSidecarReader(harness.fs);

    await reader.refresh({ subagentsDir: DIR });
    reader.clear();
    expect(reader.current().agentCount).toBe(0);

    await reader.refresh({ subagentsDir: DIR });
    expect(harness.calls.filter(c => c.op === 'readRange' && c.start === 0)).toHaveLength(2);
  });
});
