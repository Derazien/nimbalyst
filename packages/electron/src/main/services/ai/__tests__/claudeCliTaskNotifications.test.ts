// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  buildSubagentCompletionContent,
  extractTaskNotifications,
  createSubagentCompletionLogger,
  extractPersistedCompletionKeys,
} from '../claudeCliTaskNotifications';

const block = (fields: Record<string, string>) =>
  `<task-notification>\n${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('\n')}\n</task-notification>`;

const agentDone = block({
  'task-id': 'a8b6107638119d9d6',
  'tool-use-id': 'toolu_spawn',
  'output-file': 'C:\\tmp\\claude\\s\\tasks\\a8b6107638119d9d6.output',
  status: 'completed',
  summary: 'Agent "Implement" finished',
  note: 'fires each time this agent stops',
  result: 'Status: DONE.\nTests pass.',
});

describe('claudeCliTaskNotifications', () => {
  it('parses notifications out of string and block content, maps the CLI status words, and finds them anywhere in history', () => {
    const killed = block({ 'task-id': 'b1', 'tool-use-id': 'toolu_k', status: 'killed', summary: 'Agent "X" was stopped' });
    const failed = block({ 'task-id': 'b2', 'tool-use-id': 'toolu_f', status: 'failed', summary: 'Agent "Y" failed' });
    const found = extractTaskNotifications({
      messages: [
        { role: 'user', content: `<system-reminder>r</system-reminder>\n${agentDone}` },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'x' },
            { type: 'text', text: `${killed}\n${failed}` },
          ],
        },
      ],
    });

    expect(found.map((n) => [n.toolUseId, n.status])).toEqual([
      ['toolu_spawn', 'completed'], ['toolu_k', 'stopped'], ['toolu_f', 'failed'],
    ]);
    expect(found[0]).toMatchObject({
      taskId: 'a8b6107638119d9d6', summary: 'Agent "Implement" finished', result: 'Status: DONE.\nTests pass.',
    });
    // The same block seen in another request is the same notification identity.
    expect(found[0].key).toBe(extractTaskNotifications({ messages: [{ role: 'user', content: agentDone }] })[0].key);
  });

  it('builds a completion row the parser can read, with the result capped', () => {
    const [n] = extractTaskNotifications({
      messages: [{ role: 'user', content: block({ 'task-id': 't', status: 'completed', summary: 's', result: 'r'.repeat(10_000) }) }],
    });
    const row = JSON.parse(buildSubagentCompletionContent(n, 'toolu_spawn'));
    expect(row).toMatchObject({
      type: 'nimbalyst_subagent_completion', tool_use_id: 'toolu_spawn', status: 'completed', summary: 's', task_id: 't',
    });
    expect(row.result.length).toBeLessThan(3000);
  });

  it('persists one row per notification, maps it to its spawn by tool-use id or task id, and dedupes the replay in later requests', async () => {
    const created: string[] = [];
    const logger = createSubagentCompletionLogger({
      sessionId: 's1',
      workspacePath: '/w',
      seen: new Set<string>(),
      deps: {
        createMessage: async (row) => { created.push(row.content); },
        notifyMessageLogged: vi.fn(),
        now: () => new Date(0),
      },
    });
    const spawns = [
      { toolUseId: 'toolu_spawn', resultText: 'Async agent launched.' },
      { toolUseId: 'toolu_bg2', resultText: 'Async agent launched. output_file: /t/tasks/zz9.output' },
    ];
    const viaId = { messages: [{ role: 'user', content: agentDone }] };
    // No tool-use-id in the block: resolved through the task id the spawn result reported.
    const viaTask = {
      messages: [{ role: 'user', content: block({ 'task-id': 'zz9', status: 'failed', summary: 'Agent "B" failed' }) }],
    };
    // A background shell, not an agent: no row.
    const unknown = {
      messages: [{
        role: 'user',
        content: block({ 'task-id': 'bash1', 'tool-use-id': 'toolu_bash', status: 'completed', summary: 'Background command done' }),
      }],
    };

    await logger.log(viaId, spawns);
    await logger.log(viaId, spawns); // replayed in the next request
    await logger.log(viaTask, spawns);
    await logger.log(unknown, spawns);

    expect(created.map((c) => { const r = JSON.parse(c); return [r.tool_use_id, r.status]; })).toEqual([
      ['toolu_spawn', 'completed'], ['toolu_bg2', 'failed'],
    ]);
  });

  it('survives a restart: persisted completion keys pre-seed the dedupe set', () => {
    const [n] = extractTaskNotifications({ messages: [{ role: 'user', content: agentDone }] });
    const keys = extractPersistedCompletionKeys([
      { content: buildSubagentCompletionContent(n, 'toolu_spawn') },
      { content: '{"type":"assistant"}' },
      { content: 'not json nimbalyst_subagent_completion' },
    ]);
    expect([...keys]).toEqual([n.key]);
  });
});
