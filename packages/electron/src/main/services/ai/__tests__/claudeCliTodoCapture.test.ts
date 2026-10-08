// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ClaudeCliTodoCapture, normalizeTaskCreateResult } from '../claudeCliTodoCapture';

function setup(initial: Record<string, unknown> = {}) {
  let metadata: Record<string, unknown> = { ...initial };
  const saveMetadata = vi.fn(async (_id: string, next: Record<string, unknown>) => {
    metadata = next;
  });
  const notify = vi.fn();
  const capture = new ClaudeCliTodoCapture({
    loadMetadata: async () => metadata,
    saveMetadata,
    notify,
  });
  const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
  const ok = (toolUseId: string, content: string) => ({ toolUseId, content, isError: false });
  /** A lead turn: observed, then attributed, then (optionally) its results. */
  const leadTurn = async (blocks: ReturnType<typeof toolUse>[]) => {
    capture.noteAssistantToolUses('s1', blocks);
    return capture.noteTurnAttributed('s1', blocks, true);
  };
  return { capture, saveMetadata, notify, toolUse, ok, leadTurn, meta: () => metadata };
}

describe('ClaudeCliTodoCapture', () => {
  it('TodoWrite writes currentTodos, keeps other metadata keys, and refreshes the renderer', async () => {
    const { toolUse, leadTurn, meta, notify } = setup({ title: 'keep me', currentTaskList: [] });
    const todos = [{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }];
    await leadTurn([toolUse('t1', 'TodoWrite', { todos })]);
    expect(meta()).toEqual({ title: 'keep me', currentTaskList: [], currentTodos: todos });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('TaskCreate takes its id from the tool_result, whether text or JSON, and TaskUpdate/delete mutate the list', async () => {
    const { capture, toolUse, ok, leadTurn, meta } = setup();
    await leadTurn([toolUse('c1', 'TaskCreate', { subject: 'First', activeForm: 'Doing first' })]);
    await capture.noteToolResults('s1', [ok('c1', 'Task #1 created successfully: First')]);
    await leadTurn([toolUse('c2', 'TaskCreate', { subject: 'Second' })]);
    await capture.noteToolResults('s1', [ok('c2', JSON.stringify({ task: { id: '2', subject: 'Second' } }))]);
    expect(meta().currentTaskList).toMatchObject([
      { id: '1', subject: 'First', status: 'pending', activeForm: 'Doing first' },
      { id: '2', subject: 'Second', status: 'pending' },
    ]);

    await leadTurn([toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]);
    await capture.noteToolResults('s1', [ok('u1', 'Updated task #1 status')]);
    expect((meta().currentTaskList as Array<{ id: string; status: string }>)[0]).toMatchObject({
      id: '1',
      status: 'in_progress',
    });

    await leadTurn([toolUse('u2', 'TaskUpdate', { taskId: '2', status: 'deleted' })]);
    await capture.noteToolResults('s1', [ok('u2', 'Updated task #2 deleted')]);
    expect((meta().currentTaskList as Array<{ id: string }>).map((t) => t.id)).toEqual(['1']);
  });

  it('applies a result that beat attribution, and ignores the same result replayed in later request bodies', async () => {
    const { capture, toolUse, ok, saveMetadata } = setup();
    const blocks = [toolUse('c1', 'TaskCreate', { subject: 'Raced' })];
    capture.noteAssistantToolUses('s1', blocks);
    // The next request body arrives before the sidecar read resolves.
    expect(await capture.noteToolResults('s1', [ok('c1', 'Task #1 created')])).toBeNull();
    expect(saveMetadata).not.toHaveBeenCalled();
    expect(await capture.noteTurnAttributed('s1', blocks, true)).toMatchObject({
      currentTaskList: [{ id: '1', subject: 'Raced' }],
    });
    expect(await capture.noteToolResults('s1', [ok('c1', 'Task #1 created')])).toBeNull();
    expect(saveMetadata).toHaveBeenCalledTimes(1);
  });

  it('ignores sub-agent turns and failed results', async () => {
    const { capture, toolUse, ok, saveMetadata, leadTurn } = setup();
    const sub = [
      toolUse('s-todo', 'TodoWrite', { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }),
      toolUse('s-create', 'TaskCreate', { subject: 'Sub' }),
    ];
    capture.noteAssistantToolUses('s1', sub);
    await capture.noteTurnAttributed('s1', sub, false);
    await capture.noteToolResults('s1', [ok('s-create', 'Task #9 created')]);

    await leadTurn([toolUse('bad', 'TaskCreate', { subject: 'Fails' })]);
    await capture.noteToolResults('s1', [{ toolUseId: 'bad', content: 'Task #4 error', isError: true }]);
    expect(saveMetadata).not.toHaveBeenCalled();
  });

  it('hydrates from the persisted list so a resumed session merges onto its board', async () => {
    const { capture, toolUse, ok, leadTurn, meta } = setup({
      currentTaskList: [{ id: '1', subject: 'Existing', status: 'pending' }],
    });
    await leadTurn([toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })]);
    await capture.noteToolResults('s1', [ok('u1', 'Updated task #1')]);
    await leadTurn([toolUse('c1', 'TaskCreate', { subject: 'New' })]);
    await capture.noteToolResults('s1', [ok('c1', 'Task #2 created')]);
    expect(meta().currentTaskList).toMatchObject([
      { id: '1', subject: 'Existing', status: 'completed' },
      { id: '2', subject: 'New', status: 'pending' },
    ]);
  });

  it('writes nothing for messages without todo tools or for task reads', async () => {
    const { capture, toolUse, ok, saveMetadata, notify, leadTurn } = setup();
    await leadTurn([toolUse('b1', 'Bash', { command: 'ls' }), { type: 'text' } as never]);
    await leadTurn([toolUse('l1', 'TaskList', {})]);
    await capture.noteToolResults('s1', [ok('b1', 'file'), ok('l1', '#1 [pending] x')]);
    expect(saveMetadata).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('normalizeTaskCreateResult', () => {
  it('leaves the text form alone and lifts the id out of JSON', () => {
    expect(normalizeTaskCreateResult('Task #3 created successfully: x')).toBe('Task #3 created successfully: x');
    expect(normalizeTaskCreateResult('{"task":{"id":7}}')).toBe('Task #7 created');
    expect(normalizeTaskCreateResult('no id here')).toBe('no id here');
  });
});
