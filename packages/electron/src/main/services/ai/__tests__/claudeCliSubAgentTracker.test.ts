// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSubAgentTracking,
  getSubagentSpawns,
  hasAnySubagentSpawn,
  noteAssistantSubagentSpawns,
  noteSubagentSpawnResults,
} from '../claudeCliSubAgentTracker';

const SID = 'session-1';

const turn = (blocks: Array<{ type: string; name?: string; id?: string }>) => ({ content: blocks });

describe('claudeCliSubAgentTracker', () => {
  beforeEach(() => clearSubAgentTracking(SID));

  it('records spawns under either tool name, since 2.1.63 renamed Task to Agent', () => {
    // Matching only `Task` is what let a dozen sub-agents' turns interleave into
    // the lead transcript on every modern CLI.
    expect(hasAnySubagentSpawn(SID)).toBe(false);

    noteAssistantSubagentSpawns(SID, turn([
      { type: 'tool_use', name: 'Agent', id: 'toolu_agent' },
      { type: 'tool_use', name: 'Task', id: 'toolu_task' },
      { type: 'tool_use', name: 'Bash', id: 'toolu_bash' },
      { type: 'text' },
    ]));

    expect(getSubagentSpawns(SID).map(s => s.toolUseId).sort())
      .toEqual(['toolu_agent', 'toolu_task']);
    expect(hasAnySubagentSpawn(SID)).toBe(true);
  });

  it('attaches result text to its spawn and ignores unrelated tool results', () => {
    // The text is load-bearing: an in-process teammate has no toolUseId in its
    // sidecar meta, so `agent_id: name@team` here is its only link to the spawn.
    noteAssistantSubagentSpawns(SID, turn([{ type: 'tool_use', name: 'Agent', id: 'toolu_agent' }]));
    noteSubagentSpawnResults(SID, [
      { toolUseId: 'toolu_bash_inner', content: 'unrelated' },
      { toolUseId: 'toolu_agent', content: 'agent_id: atlas@session-x' },
    ]);

    expect(getSubagentSpawns(SID)).toEqual([
      { toolUseId: 'toolu_agent', resultText: 'agent_id: atlas@session-x' },
    ]);
  });

  it('reports a spawn before its result lands, with no result text yet', () => {
    noteAssistantSubagentSpawns(SID, turn([{ type: 'tool_use', name: 'Agent', id: 'toolu_agent' }]));

    expect(getSubagentSpawns(SID)).toEqual([{ toolUseId: 'toolu_agent', resultText: null }]);
  });

  it('keeps a spawn recorded after it completes, since attribution outlives the run', () => {
    // A background agent's turns can still be attributed after its tool_result
    // has landed, so the registry never forgets a spawn mid-session.
    noteAssistantSubagentSpawns(SID, turn([{ type: 'tool_use', name: 'Agent', id: 'toolu_agent' }]));
    noteSubagentSpawnResults(SID, [{ toolUseId: 'toolu_agent', content: 'done' }]);

    expect(hasAnySubagentSpawn(SID)).toBe(true);
    expect(getSubagentSpawns(SID)[0].resultText).toBe('done');
  });

  it('clears per session', () => {
    noteAssistantSubagentSpawns(SID, turn([{ type: 'tool_use', name: 'Agent', id: 'toolu_agent' }]));
    clearSubAgentTracking(SID);

    expect(hasAnySubagentSpawn(SID)).toBe(false);
    expect(getSubagentSpawns(SID)).toEqual([]);
  });
});
