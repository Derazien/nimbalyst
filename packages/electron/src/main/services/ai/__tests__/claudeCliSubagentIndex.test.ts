// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildClaudeCliSubagentIndex,
  collectSidecarMessageIds,
  emptyClaudeCliSubagentIndex,
  isSubagentToolName,
  parseAgentHandlesFromToolResult,
  parseSubagentIdFromFileName,
} from '../claudeCliSubagentIndex';

/**
 * Fixtures mirror shapes measured on a real 56-agent CLI session (2026-08-23),
 * not invented ones. The two that matter:
 *
 *   plain     agent-a050d14104033ee02.meta.json
 *             {"agentType":"general-purpose","description":"…",
 *              "toolUseId":"toolu_01KquWWqmDSBjGm2BotGwNUT",
 *              "parentAgentId":"a29770056a2b8e0b2","spawnDepth":2}
 *
 *   teammate  agent-aarch-deck-483ae151b77d91ac.meta.json
 *             {"agentType":"arch-deck","name":"arch-deck","spawnDepth":0,
 *              "taskKind":"in_process_teammate","teamName":"session-878829f3", …}
 */

describe('parseSubagentIdFromFileName', () => {
  it('reads the id from both sidecar file kinds', () => {
    expect(parseSubagentIdFromFileName('agent-a050d14104033ee02.jsonl')).toBe('a050d14104033ee02');
    expect(parseSubagentIdFromFileName('agent-a050d14104033ee02.meta.json')).toBe('a050d14104033ee02');
  });

  it('keeps ids that embed a name or a compaction marker intact', () => {
    expect(parseSubagentIdFromFileName('agent-aarch-deck-483ae151b77d91ac.jsonl'))
      .toBe('aarch-deck-483ae151b77d91ac');
    expect(parseSubagentIdFromFileName('agent-acompact-9f2b1c.jsonl')).toBe('acompact-9f2b1c');
  });

  it('ignores anything that is not a sidecar', () => {
    expect(parseSubagentIdFromFileName('notes.txt')).toBeNull();
    expect(parseSubagentIdFromFileName('agent-.jsonl')).toBeNull();
    expect(parseSubagentIdFromFileName('agent-a1.output')).toBeNull();
  });
});

describe('collectSidecarMessageIds', () => {
  it('takes ids from assistant rows only, deduped', () => {
    // The CLI writes one row per content block, all sharing a message id.
    const entries = [
      { type: 'user', agentId: 'a1', message: {} },
      { type: 'attachment', agentId: 'a1' },
      { type: 'assistant', agentId: 'a1', message: { id: 'msg_011CeFeSvWroVk9jubDGEdmw' } },
      { type: 'assistant', agentId: 'a1', message: { id: 'msg_011CeFeSvWroVk9jubDGEdmw' } },
      { type: 'assistant', agentId: 'a1', message: { id: 'msg_02second' } },
    ];
    expect(collectSidecarMessageIds(entries)).toEqual([
      'msg_011CeFeSvWroVk9jubDGEdmw',
      'msg_02second',
    ]);
  });

  it('survives rows with no message payload', () => {
    expect(collectSidecarMessageIds([{ type: 'assistant' }, { type: 'assistant', message: null }]))
      .toEqual([]);
  });
});

describe('parseAgentHandlesFromToolResult', () => {
  it('reads the teammate mailbox handle', () => {
    const text = 'Spawned successfully. (This tool result is internal metadata …)\n'
      + 'agent_id: arch-deck@session-878829f3\nname: arch-deck\n'
      + 'The agent is now running and will receive instructions via mailbox.';
    expect(parseAgentHandlesFromToolResult(text).teammateHandle).toBe('arch-deck@session-878829f3');
  });

  it('reads the agent id out of a backgrounded agent output path, escaped or not', () => {
    const escaped = 'output_file: C:\\\\Users\\\\Dera\\\\…\\\\tasks\\\\a72981571cbad2a9c.output\\nDo NOT Read';
    expect(parseAgentHandlesFromToolResult(escaped).outputFileAgentId).toBe('a72981571cbad2a9c');
    const posix = 'output_file: /tmp/claude/tasks/abd1d6a5d6232e92d.output';
    expect(parseAgentHandlesFromToolResult(posix).outputFileAgentId).toBe('abd1d6a5d6232e92d');
  });

  it('returns nothing for a result carrying neither handle', () => {
    expect(parseAgentHandlesFromToolResult('done')).toEqual({});
    expect(parseAgentHandlesFromToolResult(null)).toEqual({});
  });
});

describe('buildClaudeCliSubagentIndex', () => {
  const plain = {
    agentId: 'a050d14104033ee02',
    meta: {
      agentType: 'general-purpose',
      description: 'Mobile voice agent research',
      toolUseId: 'toolu_01KquWWqmDSBjGm2BotGwNUT',
      parentAgentId: 'a29770056a2b8e0b2',
      spawnDepth: 2,
    },
    messageIds: ['msg_plain1', 'msg_plain2'],
  };

  const teammate = {
    agentId: 'aarch-deck-483ae151b77d91ac',
    meta: {
      agentType: 'arch-deck',
      name: 'arch-deck',
      teamName: 'session-878829f3',
      taskKind: 'in_process_teammate',
      spawnDepth: 0,
      model: 'fable',
    },
    messageIds: ['msg_team1'],
  };

  it('resolves a plain sub-agent through meta.toolUseId, with no spawn observed', () => {
    // meta.toolUseId is authoritative, so attribution works before the Agent
    // tool_result lands. That is what lets a nested agent resolve at all: its
    // spawn lives inside another agent's sidecar, never in the main transcript.
    const index = buildClaudeCliSubagentIndex({ sidecars: [plain] });

    expect(index.agentIdForMessageId('msg_plain1')).toBe('a050d14104033ee02');
    expect(index.parentToolUseIdForMessageId('msg_plain1')).toBe('toolu_01KquWWqmDSBjGm2BotGwNUT');
    expect(index.parentToolUseIdForMessageId('msg_plain2')).toBe('toolu_01KquWWqmDSBjGm2BotGwNUT');
    expect(index.metaForAgentId('a050d14104033ee02')?.parentAgentId).toBe('a29770056a2b8e0b2');
  });

  it('resolves an in-process teammate through name@teamName on the spawn result', () => {
    const index = buildClaudeCliSubagentIndex({
      sidecars: [teammate],
      spawns: [{
        toolUseId: 'toolu_01SpawnedTheTeammate',
        resultText: 'agent_id: arch-deck@session-878829f3\nname: arch-deck',
      }],
    });

    expect(index.parentToolUseIdForMessageId('msg_team1')).toBe('toolu_01SpawnedTheTeammate');
  });

  it('does not resolve a teammate until its spawn result has been observed', () => {
    // A teammate carries no toolUseId, so before the result lands the turn is
    // unattributable. The caller must treat that as "not yet", never as "lead".
    const index = buildClaudeCliSubagentIndex({ sidecars: [teammate] });

    expect(index.agentIdForMessageId('msg_team1')).toBe('aarch-deck-483ae151b77d91ac');
    expect(index.parentToolUseIdForMessageId('msg_team1')).toBeUndefined();
  });

  it('falls back to the tasks/<agentId>.output path for a backgrounded agent', () => {
    const backgrounded = {
      agentId: 'a72981571cbad2a9c',
      meta: { agentType: 'general-purpose' },
      messageIds: ['msg_bg1'],
    };
    const index = buildClaudeCliSubagentIndex({
      sidecars: [backgrounded],
      spawns: [{
        toolUseId: 'toolu_01FdY15Lt85frPMZryQ4KRQ4',
        resultText: 'output_file: C:\\\\…\\\\tasks\\\\a72981571cbad2a9c.output',
      }],
    });

    expect(index.parentToolUseIdForMessageId('msg_bg1')).toBe('toolu_01FdY15Lt85frPMZryQ4KRQ4');
  });

  it('keeps concurrent agents apart, which is the whole point of the index', () => {
    // The retired in-flight flag could only say "some agent is running". With
    // eight to twelve agents at once that answer attributes nothing.
    const second = {
      agentId: 'a19a34a766db4f645',
      meta: { agentType: 'Explore', toolUseId: 'toolu_013FWaXvCkX9y9khe1tgNc1F' },
      messageIds: ['msg_second'],
    };
    const index = buildClaudeCliSubagentIndex({ sidecars: [plain, second] });

    expect(index.parentToolUseIdForMessageId('msg_plain1')).toBe('toolu_01KquWWqmDSBjGm2BotGwNUT');
    expect(index.parentToolUseIdForMessageId('msg_second')).toBe('toolu_013FWaXvCkX9y9khe1tgNc1F');
    expect(index.agentCount).toBe(2);
  });

  it('never lets a fork claim the lead turn it forked from', () => {
    // Measured: a fork's sidecar opens with the turn it forked from, carrying the
    // fork's agentId but the LEAD's message id, at index 0 on all three forks in
    // the reference session. Attributing it would nest the lead's own output under
    // an agent node, which is this file's defect mirrored.
    const fork = {
      agentId: 'a72981571cbad2a9c',
      meta: { agentType: 'fork', isFork: true, name: 'workstation-atlas', spawnDepth: 1,
              toolUseId: 'toolu_01SpawnedTheFork' },
      messageIds: ['msg_011CeHegiXBrSrMSw9UxLvEH', 'msg_forkOwnWork'],
    };
    const index = buildClaudeCliSubagentIndex({
      sidecars: [fork],
      leadMessageIds: ['msg_011CeHegiXBrSrMSw9UxLvEH'],
    });

    expect(index.agentIdForMessageId('msg_011CeHegiXBrSrMSw9UxLvEH')).toBeUndefined();
    expect(index.parentToolUseIdForMessageId('msg_011CeHegiXBrSrMSw9UxLvEH')).toBeUndefined();
    // The fork's own later turns still attribute normally.
    expect(index.parentToolUseIdForMessageId('msg_forkOwnWork')).toBe('toolu_01SpawnedTheFork');
  });

  it('does not let a fork displace the agent that actually produced a turn', () => {
    // Belt and braces for the case where the caller cannot supply lead ids.
    const producer = {
      agentId: 'a_producer',
      meta: { agentType: 'general-purpose', toolUseId: 'toolu_producer' },
      messageIds: ['msg_shared'],
    };
    const fork = {
      agentId: 'a_fork',
      meta: { agentType: 'fork', isFork: true, toolUseId: 'toolu_fork' },
      messageIds: ['msg_shared'],
    };

    for (const sidecars of [[producer, fork], [fork, producer]]) {
      const index = buildClaudeCliSubagentIndex({ sidecars });
      expect(index.agentIdForMessageId('msg_shared')).toBe('a_producer');
    }
  });

  it('leaves a lead turn unattributed', () => {
    const index = buildClaudeCliSubagentIndex({ sidecars: [plain] });

    expect(index.agentIdForMessageId('msg_lead')).toBeUndefined();
    expect(index.parentToolUseIdForMessageId('msg_lead')).toBeUndefined();
  });

  it('tolerates a sidecar whose meta.json is missing', () => {
    const index = buildClaudeCliSubagentIndex({
      sidecars: [{ agentId: 'a_nometa', meta: null, messageIds: ['msg_nometa'] }],
    });

    // The agent is still known by message id, it just cannot name its spawn.
    expect(index.agentIdForMessageId('msg_nometa')).toBe('a_nometa');
    expect(index.parentToolUseIdForMessageId('msg_nometa')).toBeUndefined();
    expect(index.metaForAgentId('a_nometa')).toBeUndefined();
    expect(index.agentCount).toBe(1);
  });

  it('exposes an empty index for a session with no sidecars yet', () => {
    const index = emptyClaudeCliSubagentIndex();
    expect(index.agentCount).toBe(0);
    expect(index.parentToolUseIdForMessageId('msg_anything')).toBeUndefined();
  });
});

describe('isSubagentToolName', () => {
  it('accepts both spellings, since 2.1.63 renamed Task to Agent', () => {
    expect(isSubagentToolName('Agent')).toBe(true);
    expect(isSubagentToolName('Task')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isSubagentToolName('Bash')).toBe(false);
    expect(isSubagentToolName(undefined)).toBe(false);
  });
});

describe('buildClaudeCliSubagentIndex with CLI 2.1.299 teammates', () => {
  // Live shape (session ffa4af0b, 14 Oct): the spawn result now reports the
  // sidecar's own id, not name@teamName, and carries no tasks/*.output path.
  // Every turn of the teammate landed in the main conversation.
  it('resolves a teammate whose spawn result reports the sidecar agent id itself', () => {
    const index = buildClaudeCliSubagentIndex({
      sidecars: [{
        agentId: 'apanel-comments-widget-89a50dd6cf42da1c',
        meta: { agentType: 'general-purpose', name: 'panel-comments-widget', taskKind: 'in_process_teammate', spawnDepth: 0 },
        messageIds: ['msg_011Cg292LPdXEo2ToZ5nYTSM'],
      }],
      spawns: [{ toolUseId: 'toolu_01NCy8qKArG2Yi9BUJskkiAk', resultText: 'Spawned successfully.\nagent_id: apanel-comments-widget-89a50dd6cf42da1c' }],
    });
    expect(index.parentToolUseIdForMessageId('msg_011Cg292LPdXEo2ToZ5nYTSM')).toBe('toolu_01NCy8qKArG2Yi9BUJskkiAk');
  });
});
