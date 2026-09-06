/**
 * The two compose behaviours that have to hold through the real UI:
 * adding a second recipient promotes Tier 1 into the full request, and no
 * subject is published without the author confirming the exact list.
 *
 * The tier rules themselves are covered in feedbackComposeDraft.test.ts; this
 * file only proves the widget is wired to them.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { feedbackRecipientDirectoryAtom } from '../../../../../store/atoms/feedbackRecipientDirectory';
import { clearFeedbackRequestComposeDraft } from '../../../../../store/atoms/feedbackRequestComposeDraft';
import { FeedbackRequestComposeWidget } from '../feedback/FeedbackRequestComposeWidget';
import type { FeedbackAskArtifact } from '@nimbalyst/collab-protocol';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

const SESSION_ID = 'session-compose';

function makeMessage(
  toolCallId: string,
  args: Record<string, unknown>,
  result: unknown = null,
) {
  return {
    toolCall: {
      providerToolCallId: toolCallId,
      toolName: 'RequestFeedback',
      arguments: {
        orgId: 'org-1',
        recipients: [{ userId: 'u-karl', name: 'Karl Reyes' }],
        asks: [
          {
            type: 'singleSelect',
            id: 'ask-direction',
            label: 'Direction',
            description: 'Which of these should we build?',
            options: [
              { id: 'a', label: 'A · Split panel' },
              { id: 'b', label: 'B · Radial' },
            ],
          },
        ],
        ...args,
      },
      result,
    },
  } as any;
}

function renderWidget(
  toolCallId: string,
  args: Record<string, unknown> = {},
  result: unknown = null,
) {
  return render(
    <JotaiProvider store={store}>
      <FeedbackRequestComposeWidget
        message={makeMessage(toolCallId, args, result)}
        sessionId={SESSION_ID}
        isExpanded={false}
        onToggle={() => {}}
      />
    </JotaiProvider>,
  );
}

function makeHost(send: ReturnType<typeof vi.fn>): InteractiveWidgetHost {
  return {
    feedbackRequestSend: send,
    feedbackRequestCancel: vi.fn().mockResolvedValue(undefined),
  } as unknown as InteractiveWidgetHost;
}

describe('FeedbackRequestComposeWidget', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue({ success: true, requestId: 'fr-1' });
    setInteractiveWidgetHost(SESSION_ID, makeHost(send));
    store.set(feedbackRecipientDirectoryAtom, [
      { userId: 'u-karl', name: 'Karl Reyes' },
      { userId: 'u-dana', name: 'Dana Ok' },
    ]);
  });

  it('adding a second recipient promotes the quick ask into the full request', () => {
    const toolCallId = 'tc-promote';
    clearFeedbackRequestComposeDraft(toolCallId);
    renderWidget(toolCallId);

    // Tier 1: one collapsed line of defaults, no delivery fields, no
    // per-person ask assignment.
    screen.getByTestId('feedback-compose-defaults');
    expect(screen.queryByTestId('feedback-compose-delivery-block')).toBeNull();
    expect(screen.queryByTestId('feedback-compose-ask-chip')).toBeNull();

    fireEvent.click(screen.getByTestId('feedback-compose-add-recipient'));
    fireEvent.click(screen.getByTestId('feedback-compose-candidate'));

    // Tier 2: same card, now disclosing delivery and assignment.
    screen.getByTestId('feedback-compose-delivery-block');
    screen.getByTestId('feedback-compose-recipient-block');
    expect(screen.queryByTestId('feedback-compose-defaults')).toBeNull();
  });

  it('does not publish or send an unshared subject until the author confirms', async () => {
    const toolCallId = 'tc-publish';
    clearFeedbackRequestComposeDraft(toolCallId);
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'file', sourceId: 'direction-a' },
          label: 'direction-a.mockup.html',
          shared: false,
        },
      ],
    });

    // Pressing the primary action surfaces the list instead of sending.
    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    expect(send).not.toHaveBeenCalled();
    screen.getByTestId('feedback-compose-publish-item');

    fireEvent.click(await screen.findByTestId('feedback-compose-publish-confirm'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].publishSubjectRefs).toEqual([
      { orgId: 'org-1', kind: 'file', sourceId: 'direction-a' },
    ]);
  });

  it('stays sent after the transcript unmounts and remounts the row', async () => {
    const toolCallId = 'tc-sent-remount';
    clearFeedbackRequestComposeDraft(toolCallId);
    send.mockResolvedValue({ success: true, warning: 'Tracker link unavailable: decision trackers are private in this workspace.' });
    const first = renderWidget(toolCallId);
    const state = () => screen
      .getByTestId('feedback-request-compose-widget')
      .getAttribute('data-state');

    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    await vi.waitFor(() => expect(state()).toBe('sent'));
    expect(send).toHaveBeenCalledTimes(1);

    /*
     * The transcript's virtual scroller unmounts off-screen rows, which is the
     * whole reason the draft lives in an atom family. Sent-ness has to live
     * there too: re-seeding a fully sendable draft under a Send button the
     * author already pressed is how one request becomes three.
     */
    first.unmount();
    renderWidget(toolCallId);

    expect(state()).toBe('sent');
    expect(screen.getByText('Tracker link unavailable: decision trackers are private in this workspace.')).toBeTruthy();
    expect(screen.queryByTestId('feedback-compose-send')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft on screen when the send fails, so the author can retry', async () => {
    const toolCallId = 'tc-send-failed';
    clearFeedbackRequestComposeDraft(toolCallId);
    send.mockResolvedValue({ success: false, error: 'The room refused the request.' });
    renderWidget(toolCallId);

    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    await screen.findByText('The room refused the request.');

    // Still the draft, not the sent card: the composed request is intact and
    // the primary action is available again.
    expect(
      screen.getByTestId('feedback-request-compose-widget').getAttribute('data-state'),
    ).toBe('draft-quick');
    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the confirmed publish set after a failed send, so the retry does not re-ask', async () => {
    const toolCallId = 'tc-publish-retry';
    clearFeedbackRequestComposeDraft(toolCallId);
    // What a cancelled share-to-team dialog looks like from here.
    send.mockResolvedValue({ success: false, error: 'Sharing direction-a was cancelled.' });
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'file', sourceId: 'direction-a' },
          label: 'direction-a.mockup.html',
          shared: false,
        },
      ],
    });

    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    fireEvent.click(await screen.findByTestId('feedback-compose-publish-confirm'));
    await screen.findByText('Sharing direction-a was cancelled.');

    // The author confirmed the publish list once. Pressing send again goes
    // straight back out with the same asks, recipients and publish set instead
    // of dropping them or asking a second time.
    expect(screen.queryByTestId('feedback-compose-publish-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('feedback-compose-send'));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({
      publishSubjectRefs: [{ orgId: 'org-1', kind: 'file', sourceId: 'direction-a' }],
      recipients: [{ userId: 'u-karl', name: 'Karl Reyes' }],
    });
    expect(send.mock.calls[1][0].asks.map((ask: { id: string }) => ask.id)).toEqual(['ask-direction']);
  });

  it('carries the destination the author picked into the send payload', async () => {
    const toolCallId = 'tc-destination';
    clearFeedbackRequestComposeDraft(toolCallId);
    const pick = vi.fn().mockResolvedValue({ folderId: 'f-mockups', path: 'Design/Mockups' });
    setInteractiveWidgetHost(SESSION_ID, {
      ...makeHost(send),
      pickFeedbackDestination: pick,
    } as unknown as InteractiveWidgetHost);
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'file', sourceId: 'direction-a' },
          label: 'direction-a.mockup.html',
          shared: false,
        },
      ],
    });

    fireEvent.click(screen.getByTestId('feedback-compose-change-destination'));
    await screen.findByText('Design / Mockups');
    expect(pick).toHaveBeenCalledWith({ folderId: null, subjectCount: 1 });

    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    fireEvent.click(await screen.findByTestId('feedback-compose-publish-confirm'));
    expect(send.mock.calls[0][0].destination).toEqual({
      folderId: 'f-mockups',
      path: 'Design/Mockups',
    });
  });

  it('names the destination but cannot change it when the host has no picker', () => {
    const toolCallId = 'tc-destination-no-host';
    clearFeedbackRequestComposeDraft(toolCallId);
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'file', sourceId: 'direction-a' },
          label: 'direction-a.mockup.html',
          shared: false,
        },
      ],
    });

    // Still honest about where it goes; just no way to change it from here.
    screen.getByTestId('feedback-compose-destination');
    expect(screen.queryByTestId('feedback-compose-change-destination')).toBeNull();
  });

  it('hides the destination when nothing being published lands in a folder', () => {
    const toolCallId = 'tc-destination-tracker';
    clearFeedbackRequestComposeDraft(toolCallId);
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'tracker', sourceId: 'item-9' },
          label: 'NIM-9',
          shared: false,
        },
      ],
    });

    screen.getByTestId('feedback-compose-publish-prompt');
    expect(screen.queryByTestId('feedback-compose-destination')).toBeNull();
  });

  it('renders the nonblocking tool result as an unsent draft for author approval', () => {
    const toolCallId = 'tc-tool-draft';
    clearFeedbackRequestComposeDraft(toolCallId);
    const toolResult = JSON.stringify({
      status: 'draftReady',
      draft: {
        orgId: 'org-1',
        recipients: [{ userId: 'u-karl', name: 'Karl Reyes' }],
        asks: [
          {
            type: 'confirm',
            id: 'approve',
            label: 'Approve',
            description: 'Does this direction work?',
          },
        ],
        assignments: [
          { askId: 'approve', target: { kind: 'user', userId: 'u-karl' } },
        ],
        subjects: [],
        visibility: 'hiddenUntilAnswered',
        quorumMode: 'all',
      },
    });

    renderWidget(toolCallId, { recipients: [], asks: [] }, toolResult);

    expect(
      screen.getByTestId('feedback-request-compose-widget').getAttribute('data-state'),
    ).toBe('draft-quick');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends without a publish step when every subject is already shared', () => {
    const toolCallId = 'tc-shared';
    clearFeedbackRequestComposeDraft(toolCallId);
    renderWidget(toolCallId, {
      subjects: [
        {
          ref: { orgId: 'org-1', kind: 'file', sourceId: 'direction-c' },
          label: 'direction-c.mockup.html',
          shared: true,
        },
      ],
    });

    expect(screen.queryByTestId('feedback-compose-publish-prompt')).toBeNull();
    fireEvent.click(screen.getByTestId('feedback-compose-send'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].publishSubjectRefs).toEqual([]);
  });
});

/**
 * The author has to be able to see what they are about to send.
 *
 * This surface showed flat label rows for a year: an ask could bind a mockup
 * to every option and compose would render none of them, so the one place you
 * decide whether to send a comparison was the one place you could not look at
 * it. Nothing about that was visibly broken -- the rows rendered fine.
 */
describe('compose artifact previews', () => {
  const ARTIFACT_ASK = {
    asks: [{
      type: 'singleSelect',
      id: 'ask-direction',
      label: 'Direction',
      description: 'Which of these should we build?',
      options: [
        { id: 'a', label: 'A · Split panel' },
        { id: 'b', label: 'B · Radial' },
      ],
      artifacts: [
        { entryId: 'a', ref: { orgId: 'org-1', kind: 'file', sourceId: 'mockups/a.mockup.html' }, label: 'Split panel' },
        { entryId: 'b', ref: { orgId: 'org-1', kind: 'file', sourceId: 'mockups/b.mockup.html' }, label: 'Radial' },
      ],
    }],
  };

  it('paints each bound artifact when the host can render one', () => {
    const painted: string[] = [];
    setInteractiveWidgetHost(SESSION_ID, {
      feedbackRequestSend: vi.fn(),
      feedbackRequestCancel: vi.fn(),
      renderFeedbackArtifactPreview: (
        entry: { id: string; label: string },
        artifact: FeedbackAskArtifact,
      ) => {
        painted.push(`${entry.id}:${artifact.ref.sourceId}`);
        return <div data-testid={`painted-${entry.id}`} />;
      },
    } as unknown as InteractiveWidgetHost);

    clearFeedbackRequestComposeDraft('tc-artifacts');
    // Scoped to this render: the file has no global cleanup, so `screen` also
    // sees every earlier test's tree.
    const { container } = renderWidget('tc-artifacts', ARTIFACT_ASK);

    // Each option gets its *own* artifact — binding is by entry id, and getting
    // that mapping backwards would still render two previews.
    expect(painted).toEqual([
      'a:mockups/a.mockup.html',
      'b:mockups/b.mockup.html',
    ]);
    expect(
      container.querySelectorAll('[data-testid="feedback-compose-option-card"]'),
    ).toHaveLength(2);
  });

  it('keeps the plain option rows when the host cannot paint artifacts', () => {
    // Set explicitly rather than inherited: this describe is a sibling of the
    // one that owns the shared beforeEach, and "a host with no renderer" is the
    // precondition under test rather than a default to fall into.
    setInteractiveWidgetHost(SESSION_ID, {
      feedbackRequestSend: vi.fn(),
      feedbackRequestCancel: vi.fn(),
    } as unknown as InteractiveWidgetHost);

    clearFeedbackRequestComposeDraft('tc-no-renderer');
    const { container } = renderWidget('tc-no-renderer', ARTIFACT_ASK);

    // A host with no renderer — mobile, or a build with no editor registry —
    // still shows a complete, readable draft rather than a row of empty frames.
    expect(
      container.querySelector('[data-testid="feedback-compose-option-card"]'),
    ).toBeNull();
    expect(container.textContent).toContain('A · Split panel');
  });
});
