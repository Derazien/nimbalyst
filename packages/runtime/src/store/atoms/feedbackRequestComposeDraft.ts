/**
 * Feedback-request compose draft atoms.
 *
 * Per-tool-call draft state for the compose surface, in a jotai atomFamily
 * keyed by toolCall.providerToolCallId so the author's edits (recipients, ask
 * assignment, delivery settings, publish confirmation) survive widget unmount
 * -- session switches and the transcript's virtual scroller unmounting
 * off-screen rows. Same pattern as askUserQuestionDraft/requestUserInputDraft.
 *
 * The widget owns this state; nothing is lifted into a parent.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import type { FeedbackComposeDraft } from '../../ui/AgentTranscript/components/CustomToolWidgets/feedback/feedbackComposeDraft';

/** null until the widget seeds it from the tool call's arguments. */
export const feedbackRequestComposeDraftAtom = atomFamily((_toolCallId: string) =>
  atom<FeedbackComposeDraft | null>(null),
);

/** What a completed send leaves behind. */
export interface FeedbackComposeSent {
  requestId?: string;
  shareUrl?: string;
  warning?: string;
  sentAt: number;
}

/**
 * Sent-ness, and it has to be at least as durable as the draft.
 *
 * The draft was given an atom family so the author's edits survive the
 * transcript's virtual scroller unmounting an off-screen row. Sending was left
 * in `useState`, so the *one* fact that must outlive a remount was the only one
 * that did not: coming back to the row re-seeded a pristine draft under a Send
 * button the author had already pressed, and each press created a new request.
 *
 * Kept beside the draft rather than inside it because the draft is what the
 * author is composing and this is what happened to it. A send also no longer
 * clears the draft -- an emptied atom is exactly what the seed effect treats as
 * "never composed".
 */
export const feedbackRequestComposeSentAtom = atomFamily((_toolCallId: string) =>
  atom<FeedbackComposeSent | null>(null),
);

/** Drop both atoms for a cancelled request so resolved drafts don't leak. */
export function clearFeedbackRequestComposeDraft(toolCallId: string): void {
  feedbackRequestComposeDraftAtom.remove(toolCallId);
  feedbackRequestComposeSentAtom.remove(toolCallId);
}
