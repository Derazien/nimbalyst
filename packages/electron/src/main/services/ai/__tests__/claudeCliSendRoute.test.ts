import { describe, expect, it, vi } from 'vitest';

import { routePromptToClaudeCli } from '../claudeCliSendRoute';

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    enqueue: vi.fn(async () => {
      calls.push('enqueue');
    }),
    drive: vi.fn(async () => {
      calls.push('drive');
      return true;
    }),
    newPromptId: vi.fn(() => 'cli-send-1'),
    ...overrides,
  };
}

describe('routePromptToClaudeCli', () => {
  it('queues the prompt before driving the CLI', async () => {
    const d = deps();

    await routePromptToClaudeCli(d, {
      sessionId: 'cli-session',
      workspacePath: '/workspace',
      prompt: 'Draft the reply',
    });

    expect(d.enqueue).toHaveBeenCalledWith({
      id: 'cli-send-1',
      sessionId: 'cli-session',
      prompt: 'Draft the reply',
    });
    // Driving first would find an empty queue and deliver nothing.
    expect(d.calls).toEqual(['enqueue', 'drive']);
    expect(d.drive).toHaveBeenCalledWith('cli-session', '/workspace', 'cli-send-route');
  });

  it('does not queue a second copy of a prompt the queue already claimed', async () => {
    const d = deps();

    await routePromptToClaudeCli(d, {
      sessionId: 'cli-session',
      workspacePath: '/workspace',
      prompt: 'Queued work',
      queuedPromptId: 'queued-1',
    });

    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.calls).toEqual(['drive']);
  });

  it('reports the drive result so a caller can tell delivery from a no-op', async () => {
    const d = deps({ drive: vi.fn(async () => false) });

    const delivered = await routePromptToClaudeCli(d, {
      sessionId: 'cli-session',
      workspacePath: '/workspace',
      prompt: 'Draft the reply',
    });

    expect(delivered).toBe(false);
  });
});

describe('routePromptToClaudeCli attachments', () => {
  it('carries attachments onto the queue so the CLI turn still gets them', async () => {
    const d = deps();
    const attachments = [{ type: 'image', path: '/tmp/shot.png' }];

    await routePromptToClaudeCli(d, {
      sessionId: 'cli-session',
      workspacePath: '/workspace',
      prompt: 'What is in this screenshot?',
      attachments,
    });

    expect(d.enqueue).toHaveBeenCalledWith({
      id: 'cli-send-1',
      sessionId: 'cli-session',
      prompt: 'What is in this screenshot?',
      attachments,
    });
  });

  it('leaves the attachments field off when there are none', async () => {
    const d = deps();

    await routePromptToClaudeCli(d, {
      sessionId: 'cli-session',
      workspacePath: '/workspace',
      prompt: 'Plain prompt',
      attachments: [],
    });

    expect(d.enqueue).toHaveBeenCalledWith({
      id: 'cli-send-1',
      sessionId: 'cli-session',
      prompt: 'Plain prompt',
    });
  });
});
