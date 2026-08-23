// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  collectSpawnsFromStoredRows,
  hasSubagentSidecars,
  resolveSubagentTranscript,
} from '../claudeCliSubagentTranscriptPath';
import type { SubagentSidecarFs } from '../claudeCliSubagentSidecarReader';

const DIR = '/proj/sess/subagents';

function fakeFs(files: Record<string, string>): SubagentSidecarFs {
  return {
    join: (...parts) => parts.join('/'),
    async listDir(dir) {
      const prefix = `${dir}/`;
      return Object.keys(files).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
    },
    async fileSize(filePath) {
      return files[filePath] === undefined ? null : Buffer.byteLength(files[filePath]);
    },
    async readRange(filePath, start, end) {
      return (files[filePath] ?? '').slice(start, end);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
  };
}

describe('resolveSubagentTranscript', () => {
  it('maps a transcript node back to its sidecar file', () => {
    // The node is keyed by the tool_use id; the file is named for the agent id.
    // Those are different values, which is the whole reason this exists.
    const fs = fakeFs({
      [`${DIR}/agent-a1bdea681b7e11123.meta.json`]: JSON.stringify({
        agentType: 'Explore', description: 'look around', toolUseId: 'toolu_spawn1',
      }),
      [`${DIR}/agent-a1bdea681b7e11123.jsonl`]: '{"type":"assistant"}\n',
    });

    return expect(resolveSubagentTranscript({ fs, subagentsDir: DIR, spawnToolUseId: 'toolu_spawn1' }))
      .resolves.toEqual({
        filePath: `${DIR}/agent-a1bdea681b7e11123.jsonl`,
        agentId: 'a1bdea681b7e11123',
        agentType: 'Explore',
        description: 'look around',
      });
  });

  it('resolves an in-process teammate through its spawn result', async () => {
    const fs = fakeFs({
      [`${DIR}/agent-aatlas-99ff.meta.json`]: JSON.stringify({
        agentType: 'atlas', name: 'atlas', teamName: 'session-x', taskKind: 'in_process_teammate',
      }),
      [`${DIR}/agent-aatlas-99ff.jsonl`]: '{"type":"assistant"}\n',
    });

    const resolved = await resolveSubagentTranscript({
      fs, subagentsDir: DIR, spawnToolUseId: 'toolu_team',
      spawns: [{ toolUseId: 'toolu_team', resultText: 'agent_id: atlas@session-x' }],
    });

    expect(resolved?.filePath).toBe(`${DIR}/agent-aatlas-99ff.jsonl`);
  });

  it('returns null for a node whose agent is not in this directory', async () => {
    const fs = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: JSON.stringify({ toolUseId: 'toolu_other' }),
      [`${DIR}/agent-a1.jsonl`]: '{}\n',
    });

    expect(await resolveSubagentTranscript({ fs, subagentsDir: DIR, spawnToolUseId: 'toolu_missing' }))
      .toBeNull();
  });

  it('returns null when the session has no sidecars at all', async () => {
    expect(await resolveSubagentTranscript({
      fs: fakeFs({}), subagentsDir: DIR, spawnToolUseId: 'toolu_spawn1',
    })).toBeNull();
  });

  it('returns null when meta names an agent whose transcript is gone', async () => {
    const fs = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: JSON.stringify({ toolUseId: 'toolu_spawn1' }),
    });

    expect(await resolveSubagentTranscript({ fs, subagentsDir: DIR, spawnToolUseId: 'toolu_spawn1' }))
      .toBeNull();
  });

  it('omits labels when meta.json is absent or unparseable', async () => {
    const fs = fakeFs({
      [`${DIR}/agent-a1.meta.json`]: 'not json',
      [`${DIR}/agent-a1.jsonl`]: '{}\n',
      [`${DIR}/agent-a2.meta.json`]: JSON.stringify({ toolUseId: 'toolu_spawn1' }),
      [`${DIR}/agent-a2.jsonl`]: '{}\n',
    });

    const resolved = await resolveSubagentTranscript({
      fs, subagentsDir: DIR, spawnToolUseId: 'toolu_spawn1',
    });

    expect(resolved).toEqual({ filePath: `${DIR}/agent-a2.jsonl`, agentId: 'a2' });
  });
});

describe('collectSpawnsFromStoredRows', () => {
  it('recovers a teammate spawn and its result from persisted rows', () => {
    // After a restart the in-memory spawn registry is empty, and a teammate has
    // no meta.toolUseId, so without this the control was silent on 36 of 56
    // agent nodes in the reference session.
    const rows = [
      { content: JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_1', content: [
            { type: 'tool_use', id: 'toolu_team', name: 'Agent', input: { name: 'atlas' } },
            { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} },
          ] },
        }) },
      { content: JSON.stringify({
          type: 'nimbalyst_tool_result',
          tool_use_id: 'toolu_team',
          result: 'agent_id: atlas@session-x\nname: atlas',
          is_error: false,
        }) },
    ];

    expect(collectSpawnsFromStoredRows(rows)).toEqual([
      { toolUseId: 'toolu_team', resultText: 'agent_id: atlas@session-x\nname: atlas' },
    ]);
  });

  it('accepts the older spelling and an inline tool_result block', () => {
    const rows = [
      { content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: {} }] },
        }) },
      { content: JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'agent_id: a@b' }] },
        }) },
    ];

    expect(collectSpawnsFromStoredRows(rows)).toEqual([
      { toolUseId: 'toolu_task', resultText: 'agent_id: a@b' },
    ]);
  });

  it('reports a spawn whose result has not been stored, and skips unparseable rows', () => {
    const rows = [
      { content: 'not json' },
      { content: null },
      { content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }] },
        }) },
    ];

    expect(collectSpawnsFromStoredRows(rows)).toEqual([{ toolUseId: 'toolu_a', resultText: null }]);
  });

  it('resolves a teammate end to end when only stored rows are available', async () => {
    const fs = fakeFs({
      [`${DIR}/agent-aatlas-99ff.meta.json`]: JSON.stringify({
        name: 'atlas', teamName: 'session-x', taskKind: 'in_process_teammate',
      }),
      [`${DIR}/agent-aatlas-99ff.jsonl`]: '{"type":"assistant"}\n',
    });
    const spawns = collectSpawnsFromStoredRows([
      { content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_team', name: 'Agent', input: {} }] },
        }) },
      { content: JSON.stringify({
          type: 'nimbalyst_tool_result', tool_use_id: 'toolu_team',
          result: 'agent_id: atlas@session-x',
        }) },
    ]);

    const resolved = await resolveSubagentTranscript({
      fs, subagentsDir: DIR, spawnToolUseId: 'toolu_team', spawns,
    });

    expect(resolved?.filePath).toBe(`${DIR}/agent-aatlas-99ff.jsonl`);
  });
});

describe('hasSubagentSidecars', () => {
  it('is false for a session that predates sidecars, so no dead control renders', async () => {
    // Only 3 of 56 sessions in one real project directory had a subagents dir.
    expect(await hasSubagentSidecars(fakeFs({}), DIR)).toBe(false);
    expect(await hasSubagentSidecars(fakeFs({ [`${DIR}/notes.txt`]: 'x' }), DIR)).toBe(false);
  });

  it('is true as soon as one sidecar exists', async () => {
    expect(await hasSubagentSidecars(fakeFs({ [`${DIR}/agent-a1.jsonl`]: '{}\n' }), DIR)).toBe(true);
  });
});
