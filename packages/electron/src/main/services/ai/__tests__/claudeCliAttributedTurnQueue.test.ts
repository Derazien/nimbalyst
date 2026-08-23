// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createAttributedTurnQueue } from '../claudeCliAttributedTurnQueue';

const turn = (messageId: string) => ({ messageId, message: { id: messageId } });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('claudeCliAttributedTurnQueue', () => {
  it('persists in observation order even when attribution takes longer for an earlier turn', async () => {
    // Transcript rows are read back ORDER BY id ASC, so a slow first turn
    // finishing after a fast second one would silently reorder the transcript.
    const persisted: string[] = [];
    const delays: Record<string, number> = { msg_slow: 30, msg_fast: 0 };
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => true,
      async resolveParentToolUseId(t) {
        await tick(delays[t.messageId] ?? 0);
        return undefined;
      },
      async persist(t) { persisted.push(t.messageId); },
    });

    queue.enqueue(turn('msg_slow'));
    queue.enqueue(turn('msg_fast'));
    await queue.drain();

    expect(persisted).toEqual(['msg_slow', 'msg_fast']);
  });

  it('passes the resolved parent tool_use id through to persist', async () => {
    const persist = vi.fn(async (_turn: { messageId: string }, _parent?: string) => {});
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => true,
      resolveParentToolUseId: async (t) =>
        t.messageId === 'msg_agent' ? 'toolu_spawn' : undefined,
      persist,
    });

    queue.enqueue(turn('msg_agent'));
    queue.enqueue(turn('msg_lead'));
    await queue.drain();

    expect(persist.mock.calls.map((c) => [(c[0] as any).messageId, c[1]])).toEqual([
      ['msg_agent', 'toolu_spawn'],
      ['msg_lead', undefined],
    ]);
  });

  it('skips attribution entirely when the session has never spawned an agent', async () => {
    // The fast path: no sidecar read, no wait, for the vast majority of sessions.
    const resolve = vi.fn(async () => undefined);
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => false,
      resolveParentToolUseId: resolve,
      persist: async () => {},
    });

    queue.enqueue(turn('msg_lead'));
    await queue.drain();

    expect(resolve).not.toHaveBeenCalled();
  });

  it('remembers unattributed message ids as the lead, so a fork cannot claim them', async () => {
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => true,
      resolveParentToolUseId: async (t) =>
        t.messageId === 'msg_agent' ? 'toolu_spawn' : undefined,
      persist: async () => {},
    });

    queue.enqueue(turn('msg_lead'));
    queue.enqueue(turn('msg_agent'));
    await queue.drain();

    expect([...queue.leadMessageIds()]).toEqual(['msg_lead']);
  });

  it('persists a turn whose attribution threw, rather than losing it', async () => {
    const persisted: Array<[string, string | undefined]> = [];
    const onError = vi.fn();
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => true,
      resolveParentToolUseId: async () => { throw new Error('sidecar unreadable'); },
      persist: async (t, parent) => { persisted.push([t.messageId, parent]); },
      onError,
    });

    queue.enqueue(turn('msg_one'));
    await queue.drain();

    expect(persisted).toEqual([['msg_one', undefined]]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('keeps draining after a persist failure', async () => {
    const persisted: string[] = [];
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => false,
      resolveParentToolUseId: async () => undefined,
      persist: async (t) => {
        if (t.messageId === 'msg_bad') throw new Error('db down');
        persisted.push(t.messageId);
      },
      onError: () => {},
    });

    queue.enqueue(turn('msg_bad'));
    queue.enqueue(turn('msg_good'));
    await queue.drain();

    expect(persisted).toEqual(['msg_good']);
  });

  it('accepts turns enqueued while the queue is already draining', async () => {
    const persisted: string[] = [];
    const queue = createAttributedTurnQueue({
      shouldAttribute: () => true,
      async resolveParentToolUseId() { await tick(5); return undefined; },
      persist: async (t) => { persisted.push(t.messageId); },
    });

    queue.enqueue(turn('msg_one'));
    await tick(1);
    queue.enqueue(turn('msg_two'));
    await queue.drain();

    expect(persisted).toEqual(['msg_one', 'msg_two']);
  });
});
