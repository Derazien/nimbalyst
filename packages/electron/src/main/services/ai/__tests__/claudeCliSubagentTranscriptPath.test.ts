// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveSubagentTranscript } from '../claudeCliSubagentTranscriptPath';
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
