// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createSubagentSpawnRegistry } from '../claudeCliSubagentSpawnRegistry';

const agentUse = (id: string, input: Record<string, unknown>, name = 'Agent') => ({ type: 'tool_use', id, name, input });
const body = (messages: unknown[]) => ({ model: 'claude-x', messages }) as Record<string, unknown>;

describe('claudeCliSubagentSpawnRegistry', () => {
  it('matches a sub-agent request by its first user message, through CLI-injected reminder blocks and whitespace', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([
      agentUse('toolu_a', { prompt: 'Map the effort selector\n\nand report back', run_in_background: true }),
      agentUse('toolu_b', { prompt: 'Audit the proxy', subagent_type: 'Explore' }, 'Task'),
    ]);

    const request = body([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nAvailable skills: x\n</system-reminder>' },
          { type: 'text', text: 'Map the effort   selector and report back' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'ok' }] },
    ]);

    expect(registry.matchRequest(request)).toBe('toolu_a');
    // String content with a leading reminder, and a prompt the CLI appended to.
    expect(registry.matchRequest(body([
      { role: 'user', content: '<system-reminder>ctx</system-reminder>\nAudit the proxy\nExtra trailing guidance' },
    ]))).toBe('toolu_b');
  });

  it('never claims the lead (or a fork): a body that contains the spawn call itself is not that agent', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([agentUse('toolu_a', { prompt: 'Do the thing' })]);

    // The lead's first prompt happens to equal the spawn prompt, and its own
    // history holds the Agent tool_use that spawned toolu_a.
    expect(registry.matchRequest(body([
      { role: 'user', content: 'Do the thing' },
      { role: 'assistant', content: [agentUse('toolu_a', { prompt: 'Do the thing' })] },
    ]))).toBeUndefined();
    // A request whose first user message is something else never matches.
    expect(registry.matchRequest(body([{ role: 'user', content: 'hello' }]))).toBeUndefined();
  });

  it('refuses to guess between fan-out agents given the same prompt, but prefers an exact match over a prefix', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([
      agentUse('toolu_1', { prompt: 'Review module' }),
      agentUse('toolu_2', { prompt: 'Review module' }),
      agentUse('toolu_3', { prompt: 'Review module A' }),
    ]);

    expect(registry.matchRequest(body([{ role: 'user', content: 'Review module' }]))).toBeUndefined();
    expect(registry.matchRequest(body([{ role: 'user', content: 'Review module A' }]))).toBe('toolu_3');
  });

  it('learns spawns from replayed request history (a resumed session) and keeps the launch details', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteRequestHistory(body([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [agentUse('toolu_old', {
          prompt: 'P', description: 'D', subagent_type: 'Explore', model: 'sonnet', run_in_background: true,
        })],
      },
    ]));

    expect(registry.get('toolu_old')).toMatchObject({
      prompt: 'P', description: 'D', subagentType: 'Explore', model: 'sonnet', runInBackground: true,
    });
    expect(registry.list().map((s) => s.toolUseId)).toEqual(['toolu_old']);
  });

  it('recognizes a background launch ack only for a known background spawn, not a foreground result that merely mentions the background', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([
      agentUse('toolu_bg', { prompt: 'a', run_in_background: true }),
      agentUse('toolu_fg', { prompt: 'b' }),
      agentUse('toolu_moved', { prompt: 'c' }),
    ]);
    const ack = 'Async agent launched successfully. The agent is working in the background.';

    expect(registry.backgroundLaunchAcks([
      { toolUseId: 'toolu_bg', content: ack },
      { toolUseId: 'toolu_bg', content: 'The report: the cache is warmed in the background.' },
      { toolUseId: 'toolu_fg', content: 'Cleanup runs working in the background after it.' },
      // Moved to the background mid-run: no flag on the call, but the result names the output file.
      { toolUseId: 'toolu_moved', content: 'Agent running in the background. output_file: /t/tasks/ab12.output' },
      { toolUseId: 'toolu_unknown', content: ack },
    ])).toEqual(new Set(['toolu_bg', 'toolu_moved']));
  });

  it('ignores non-spawn tools and never prompt-matches a spawn that has no prompt', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([
      { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { prompt: 'x' } },
      agentUse('toolu_empty', {}),
    ]);
    expect(registry.get('toolu_r')).toBeUndefined();
    // Still a known spawn (for completion mapping), but not matchable.
    expect(registry.get('toolu_empty')).toBeDefined();
    expect(registry.matchRequest(body([{ role: 'user', content: '' }]))).toBeUndefined();
    expect(registry.matchRequest(body([{ role: 'user', content: 'anything' }]))).toBeUndefined();
  });
});

describe('claudeCliSubagentSpawnRegistry with a teammate', () => {
  // A teammate's first message is wrapped as <teammate-message ...>PROMPT</teammate-message>.
  it('matches through the teammate-message wrapper', () => {
    const registry = createSubagentSpawnRegistry();
    registry.noteToolUses([agentUse('toolu_t', { prompt: 'Build the comments widget', run_in_background: 'true', name: 'panel-comments-widget' })]);
    expect(registry.matchRequest(body([{
      role: 'user',
      content: '<teammate-message teammate_id="team-lead" summary="Build it">\nBuild the comments widget\n</teammate-message>',
    }]))).toBe('toolu_t');
    expect(registry.get('toolu_t')?.runInBackground).toBe(true);
  });
});
