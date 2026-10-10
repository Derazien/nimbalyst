import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { RichTranscriptView } from '../RichTranscriptView';

const vlistState = vi.hoisted(() => ({ scrollToIndex: vi.fn(), scrollBy: vi.fn() }));

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vlistState.scrollToIndex,
        scrollBy: vlistState.scrollBy,
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

function makeMessage(index: number, overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

const toolCall = (name: string, id: string, args: Record<string, unknown>, result?: string) => ({
  toolName: name, toolDisplayName: name, status: 'running' as const, description: null, arguments: args,
  targetFilePath: null, mcpServer: null, mcpTool: null, providerToolCallId: id, progress: [], result,
});

function makeAgent(index: number, id: string, description: string, status: string, childEvents: TranscriptViewMessage[]) {
  return makeMessage(index, {
    type: 'subagent',
    subagentId: id,
    toolCall: toolCall('Task', id, { description, prompt: 'work', run_in_background: true }),
    subagent: {
      agentType: 'general-purpose', status, model: 'sonnet', teammateName: null, teamName: null,
      teammateMode: null, reasoningEffort: null, color: null, isBackground: true, prompt: 'work', childEvents,
    } as TranscriptViewMessage['subagent'],
  });
}

describe('Agents strip', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const flushFrames = () => {
    for (let i = 0; i < 12 && frames.size; i++) {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(0));
      });
    }
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vlistState.scrollToIndex.mockReset();
    vlistState.scrollBy.mockReset();
    vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  it('keeps agent cards collapsed, opens the one holding an unanswered question, and reveals a card from its strip line', () => {
    const read = makeMessage(10, { type: 'tool_call', toolCall: toolCall('Read', 'read-1', { file_path: 'src/a.ts' }, 'ok'), subagentId: 'agent-a' });
    const question = makeMessage(11, {
      type: 'tool_call',
      subagentId: 'agent-b',
      toolCall: toolCall('mcp__nimbalyst__AskUserQuestion', 'question-1', {
        questions: [{ header: 'Scope', question: 'Which package?', options: [{ label: 'runtime', description: 'The runtime' }] }],
      }),
    });
    const messages = [
      makeMessage(0, { type: 'user_message', text: 'go' }),
      // An unknown status must read as finished, not as running.
      makeAgent(1, 'agent-a', 'Map the repo', 'finished-eventually', [read]),
      makeAgent(2, 'agent-b', 'Fix the parser', 'running', [question]),
      makeMessage(3, { text: 'Both agents launched' }),
    ];
    const { container } = render(
      <RichTranscriptView sessionId="strip" sessionStatus="idle" messages={messages} provider="claude-code" persistScrollState={false} />,
    );

    const rows = screen.getAllByTestId('agents-strip-row');
    expect(rows.map(row => within(row).getByText(/^(running|done|failed|stopped)$/).textContent)).toEqual(['done', 'running']);
    expect(within(rows[0]).queryByTestId('agents-strip-needs-answer')).toBeNull();
    expect(within(rows[1]).getByTestId('agents-strip-needs-answer')).toBeTruthy();

    const cardA = container.querySelector<HTMLElement>('[data-transcript-tool-id="agent-a"]')!;
    const cardB = container.querySelector<HTMLElement>('[data-transcript-tool-id="agent-b"]')!;
    // B holds an open question: its card is open and the question says which agent asked.
    expect(within(within(cardB).getByTestId('subagent-question-origin')).getByText('Question from agent Fix the parser')).toBeTruthy();
    expect(within(cardB).getByTestId('ask-user-question-widget')).toBeTruthy();
    // A holds nothing to answer: it stays collapsed until asked for.
    expect(cardA.textContent).not.toContain('Sub-agent Actions');

    vi.spyOn(cardA, 'getBoundingClientRect').mockReturnValue({ top: 120 } as DOMRect);
    fireEvent.click(rows[0]);
    flushFrames();
    expect(container.querySelector('[data-transcript-tool-id="agent-a"]')!.textContent).toContain('Sub-agent Actions (1)');
    expect(vlistState.scrollToIndex).toHaveBeenCalledWith(3, { align: 'start' });
    expect(vlistState.scrollBy).toHaveBeenCalled();
  });
});
