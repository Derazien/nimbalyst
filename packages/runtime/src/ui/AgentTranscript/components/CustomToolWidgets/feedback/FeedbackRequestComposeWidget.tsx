/**
 * FeedbackRequestComposeWidget
 *
 * The compose surface: the agent drafts a request to other people, and the
 * author reviews it in the transcript before anything leaves the machine.
 *
 * Two behaviours carry this slice, and both live in `feedbackComposeDraft.ts`
 * so they are testable without rendering:
 *
 * - **Tier is derived from the draft's content, never stored.** One recipient,
 *   no deadline, nothing unshared renders as a quick ask: who, the asks, and a
 *   single collapsed line of defaults. Adding a second recipient, a deadline,
 *   or an unshared subject grows the same card into the full request. There is
 *   no second command and no mode toggle, and demoting never discards what the
 *   author already entered -- the fields stop being shown, the values stay.
 * - **Nothing publishes without an explicit confirmation** that names the exact
 *   subjects becoming visible.
 *
 * Draft state lives in a jotai atomFamily keyed by the tool call id, so it
 * survives session switches and virtual-scroll churn. The widget owns it; no
 * parent holds a copy.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import type { FeedbackAsk, ResourceRef } from '@nimbalyst/collab-protocol';
import type { CustomToolWidgetProps } from '../index';
import { interactiveWidgetHostAtom } from '../../../../../store/atoms/interactiveWidgetHost';
import { feedbackRecipientDirectoryAtom } from '../../../../../store/atoms/feedbackRecipientDirectory';
import {
  clearFeedbackRequestComposeDraft,
  feedbackRequestComposeDraftAtom,
  feedbackRequestComposeSentAtom,
} from '../../../../../store/atoms/feedbackRequestComposeDraft';
import {
  InteractiveWidgetBody,
  InteractiveWidgetCard,
  InteractiveWidgetHeader,
  WidgetActionButton,
  WidgetBlock,
  WidgetFooter,
  WidgetStatusPill,
} from '../shared/InteractiveWidgetChrome';
import {
  addRecipient,
  confirmPublish,
  describeComposeDefaults,
  destinationSubjects,
  FEEDBACK_COMPOSE_BLOCKED_MESSAGES,
  feedbackComposeSendPayload,
  feedbackComposeSubmitPlan,
  feedbackComposeTier,
  isAskAssignedTo,
  recipientsAssignedToAsk,
  removeRecipient,
  removeSubject,
  setDeadline,
  setDestination,
  setQuorumMode,
  setSettingsExpanded,
  setVisibility,
  toggleAssignment,
  unsharedSubjects,
} from './feedbackComposeDraft';
import {
  parseFeedbackComposeArgs,
  parseRequestFeedbackToolResult,
} from './parseFeedbackComposeArgs';
import { FeedbackCopyLinkButton } from './FeedbackCopyLinkButton';
import { FeedbackComposeSubjects } from './FeedbackComposeSubjects';
import {
  FeedbackComposeAddRecipient,
  FeedbackComposeRecipients,
  RecipientAvatar,
} from './FeedbackComposeRecipients';
import { FeedbackComposeDelivery, formatDeadline } from './FeedbackComposeDelivery';
import { FeedbackComposeAskPreview } from './FeedbackComposeAskPreview';
import { FeedbackComposePublishPrompt } from './FeedbackComposePublishPrompt';

const FeedbackIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="w-full h-full">
    <path
      d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v6A1.5 1.5 0 0 1 12.5 12H6l-3 2.2V12h-.5A1.5 1.5 0 0 1 1 10.5v-6"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="7.5" r="0.9" fill="currentColor" />
    <circle cx="9" cy="7.5" r="0.9" fill="currentColor" />
  </svg>
);

const ASK_TYPE_HINTS: Record<FeedbackAsk['type'], string> = {
  singleSelect: 'pick one',
  multiSelect: 'pick any',
  reorder: 'drag to rank',
  editText: 'free text',
  confirm: 'yes or no',
  rating: 'rating',
};

function joinNames(names: string[]): string {
  if (names.length === 0) return 'nobody yet';
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const FeedbackRequestComposeWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  sessionId,
}) => {
  const toolCall = message.toolCall;
  const draftId = toolCall?.providerToolCallId || '';

  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const directory = useAtomValue(feedbackRecipientDirectoryAtom);
  const [draft, setDraft] = useAtom(feedbackRequestComposeDraftAtom(draftId));
  const [sent, setSent] = useAtom(feedbackRequestComposeSentAtom(draftId));

  const parsedArgs = useMemo(
    () => (toolCall && draftId ? parseFeedbackComposeArgs(toolCall.arguments, draftId) : null),
    [toolCall, draftId],
  );
  const parsedResult = useMemo(
    () => (toolCall && draftId
      ? parseRequestFeedbackToolResult(toolCall.result, draftId)
      : null),
    [toolCall, draftId],
  );
  const parsed = parsedResult?.status === 'draftReady'
    ? parsedResult.draft
    : parsedArgs?.recipients.length
      ? parsedArgs
      : null;

  // Seed once from the agent's draft, then leave it alone so author edits are
  // never overwritten by a re-render.
  useEffect(() => {
    if (!draft && parsed) setDraft(parsed);
  }, [draft, parsed, setDraft]);

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [publishPromptForced, setPublishPromptForced] = useState(false);
  const hasSent = sent !== null;
  const shareUrl = sent?.shareUrl ?? null;
  const [now] = useState(() => Date.now());

  const update = useCallback(
    (next: (current: NonNullable<typeof draft>) => NonNullable<typeof draft>) => {
      setDraft((current) => (current ? next(current) : current));
      setSendError(null);
    },
    [setDraft],
  );

  const send = useCallback(
    async (refsToPublish: ResourceRef[]) => {
      // `hasSent` rather than `isSending`: the latter only guards a second click
      // inside one mount, and the duplicate requests came from a remount.
      if (!draft || hasSent || !host?.feedbackRequestSend) return;
      setIsSending(true);
      setSendError(null);
      try {
        const result = await host.feedbackRequestSend(
          feedbackComposeSendPayload(draft, refsToPublish),
        );
        if (result.success) {
          // The draft deliberately stays. Removing it empties the atom, which
          // the seed effect above reads as "never composed" and refills from
          // the agent's original arguments.
          setSent({
            sentAt: Date.now(),
            ...(result.requestId ? { requestId: result.requestId } : {}),
            ...(result.shareUrl ? { shareUrl: result.shareUrl } : {}),
            ...(result.warning ? { warning: result.warning } : {}),
          });
        } else {
          setSendError(result.error ?? 'The request could not be sent.');
        }
      } catch (error) {
        console.error('[FeedbackRequestComposeWidget] Failed to send:', error);
        setSendError(error instanceof Error ? error.message : 'The request could not be sent.');
      } finally {
        setIsSending(false);
      }
    },
    [draft, hasSent, host, setSent],
  );

  const handleChangeDestination = useCallback(async () => {
    if (!host?.pickFeedbackDestination) return;
    try {
      const picked = await host.pickFeedbackDestination({
        folderId: draft?.destination?.folderId ?? null,
        subjectCount: draft ? destinationSubjects(draft).length : 0,
      });
      // Dismissing the picker is not a choice; leave the draft as it was.
      if (picked) update((current) => setDestination(current, picked));
    } catch (error) {
      console.error('[FeedbackRequestComposeWidget] Failed to pick a destination:', error);
    }
  }, [host, draft, update]);

  const handleCancel = useCallback(async () => {
    try {
      await host?.feedbackRequestCancel?.(draftId);
    } catch (error) {
      console.error('[FeedbackRequestComposeWidget] Failed to cancel:', error);
    }
    clearFeedbackRequestComposeDraft(draftId);
  }, [host, draftId]);

  if (!toolCall || !draftId) return null;

  if (parsedResult && parsedResult.status !== 'draftReady') {
    return (
      <InteractiveWidgetCard
        rootClassName="feedback-request-compose-widget @container/feedback-compose"
        testId="feedback-request-compose-widget"
        state={parsedResult.status}
        tone="active"
      >
        <InteractiveWidgetHeader
          icon={<FeedbackIcon />}
          title={parsedResult.status === 'ambiguousRecipient'
            ? 'Choose a recipient'
            : 'Feedback request not drafted'}
          trailing={<WidgetStatusPill tone="muted">Not sent</WidgetStatusPill>}
        />
        <InteractiveWidgetBody>
          <div className="text-xs text-nim-muted leading-relaxed select-text">
            {parsedResult.message}
          </div>
        </InteractiveWidgetBody>
      </InteractiveWidgetCard>
    );
  }

  if (!draft) return null;

  const tier = feedbackComposeTier(draft);
  const plan = feedbackComposeSubmitPlan(draft);
  const pendingPublish = unsharedSubjects(draft);
  const recipientNames = draft.recipients.map((recipient) => recipient.name);
  const candidates = directory.filter(
    (candidate) => !draft.recipients.some((recipient) => recipient.userId === candidate.userId),
  );
  const canSend = Boolean(host?.feedbackRequestSend) && !isSending;

  // ---------- sent ----------
  if (hasSent) {
    return (
      <InteractiveWidgetCard
        rootClassName="feedback-request-compose-widget @container/feedback-compose"
        testId="feedback-request-compose-widget"
        state="sent"
        tone="resolved"
      >
        <InteractiveWidgetHeader
          icon={<FeedbackIcon />}
          title={`Asked ${joinNames(recipientNames)}`}
          trailing={<WidgetStatusPill tone="muted">Waiting on reply</WidgetStatusPill>}
        />
        <InteractiveWidgetBody>
          <div className="text-xs text-nim-muted leading-relaxed select-text">
            {draft.asks.map((ask) => ask.description || ask.label).join(' · ')}
          </div>
          {sent.warning && <div role="status" className="text-xs text-nim-muted">{sent.warning}</div>}
          {shareUrl && (
            <div
              className="feedback-compose-share flex flex-wrap items-center gap-2"
              data-testid="feedback-compose-share"
            >
              <FeedbackCopyLinkButton url={shareUrl} testId="feedback-compose-copy-link" />
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-nim-faint select-text">
                {shareUrl}
              </span>
            </div>
          )}
          {shareUrl && (
            <div className="text-[0.6875rem] text-nim-faint">
              Paste that anywhere you already talk to them — it opens in a browser,
              so they do not need Nimbalyst installed.
            </div>
          )}
          <div className="text-[0.6875rem] text-nim-faint">
            This session resumes when the questions reach quorum or are settled.
          </div>
        </InteractiveWidgetBody>
      </InteractiveWidgetCard>
    );
  }

  // ---------- primary action ----------
  const primaryLabel =
    pendingPublish.length > 0
      ? 'Publish & send'
      : tier === 'quick' && draft.recipients.length === 1
        ? `Ask ${draft.recipients[0].name}`
        : 'Send request';

  const handlePrimary = () => {
    if (plan.kind === 'blocked') return;
    if (plan.kind === 'needsPublishConfirmation') {
      // No dead end and no silent publish: surface the exact list instead.
      setPublishPromptForced(true);
      return;
    }
    void send(plan.publishSubjectRefs);
  };

  const handleConfirmPublishAndSend = () => {
    const confirmed = confirmPublish(draft);
    setDraft(confirmed);
    const confirmedPlan = feedbackComposeSubmitPlan(confirmed);
    if (confirmedPlan.kind !== 'ready') return;
    void send(confirmedPlan.publishSubjectRefs);
  };

  const footerNote =
    plan.kind === 'blocked'
      ? FEEDBACK_COMPOSE_BLOCKED_MESSAGES[plan.reason]
      : sendError
        ? sendError
        : !host?.feedbackRequestSend
          ? 'Team delivery is not available in this session yet.'
          : pendingPublish.length > 0
            ? 'Sending publishes the unshared subjects to your team.'
            : draft.subjects.length > 0
              ? 'Sending saves the questions in the shared document and notifies the selected teammates.'
              : 'Sending creates a shared decision document. Your session continues when enough answers arrive or a person settles it.';

  const showDelivery = tier === 'full' || draft.settingsExpanded;

  return (
    <InteractiveWidgetCard
      rootClassName="feedback-request-compose-widget @container/feedback-compose"
      testId="feedback-request-compose-widget"
      state={tier === 'full' ? 'draft-full' : 'draft-quick'}
      tone="active"
    >
      <InteractiveWidgetHeader
        icon={<FeedbackIcon />}
        title={tier === 'full' ? 'Feedback request' : 'Ask someone'}
        trailing={
          <WidgetStatusPill tone="primary">
            {tier === 'full' && draft.recipients.length > 1
              ? `${draft.recipients.length} recipients`
              : 'Draft — not sent'}
          </WidgetStatusPill>
        }
      />

      <InteractiveWidgetBody>
        <div className="feedback-compose-document-host text-xs text-nim-muted mb-3">
          {draft.hostDocumentId
            ? `Document: ${draft.subjects.find((subject) => subject.ref.sourceId === draft.hostDocumentId)?.label ?? draft.hostDocumentId}`
            : 'Document: new shared decision document'}
        </div>
        {/* Subject — Tier 2 only; a one-person quick ask does not need a
            subject row, and showing one implies ceremony the ask lacks. */}
        {tier === 'full' && draft.subjects.length > 0 && (
          <WidgetBlock
            tag="Subject"
            hint="what reviewers will look at"
            rootClassName="feedback-compose-subject-block"
            testId="feedback-compose-subject-block"
          >
            <FeedbackComposeSubjects
              subjects={draft.subjects}
              onRemove={(sourceId) => update((current) => removeSubject(current, sourceId))}
            />
          </WidgetBlock>
        )}

        {/* Recipients — one inline row at Tier 1, the assignable list at Tier 2. */}
        {tier === 'full' ? (
          <WidgetBlock
            tag="Recipients"
            hint="each person answers only the asks assigned to them"
            rootClassName="feedback-compose-recipient-block"
            testId="feedback-compose-recipient-block"
          >
            <FeedbackComposeRecipients
              recipients={draft.recipients}
              asks={draft.asks}
              candidates={candidates}
              isAskAssigned={(askId, userId) => isAskAssignedTo(draft, askId, userId)}
              onToggleAssignment={(askId, userId) =>
                update((current) => toggleAssignment(current, askId, userId))
              }
              onAdd={(recipient) => update((current) => addRecipient(current, recipient))}
              onRemove={(userId) => update((current) => removeRecipient(current, userId))}
              disabled={isSending}
            />
          </WidgetBlock>
        ) : (
          <div
            data-testid="feedback-compose-quick-recipients"
            className="feedback-compose-quick-recipients flex items-center gap-2 flex-wrap"
          >
            <span className="text-xs text-nim-faint">Ask</span>
            {draft.recipients.map((recipient) => (
              <span
                key={recipient.userId}
                data-testid="feedback-compose-recipient"
                className="feedback-compose-person-chip inline-flex items-center gap-1.5 rounded-full border border-nim bg-nim-secondary py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-nim"
              >
                <RecipientAvatar name={recipient.name} className="w-5 h-5" />
                {recipient.name}
                <button
                  type="button"
                  data-testid="feedback-compose-remove-recipient"
                  aria-label={`Remove ${recipient.name}`}
                  onClick={() => update((current) => removeRecipient(current, recipient.userId))}
                  className="text-nim-faint hover:text-nim cursor-pointer bg-transparent border-none p-0 leading-none"
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
            <FeedbackComposeAddRecipient
              candidates={candidates}
              onAdd={(recipient) => update((current) => addRecipient(current, recipient))}
              disabled={isSending}
            />
          </div>
        )}

        {/* Asks */}
        {draft.asks.map((ask, index) => {
          const assigned = recipientsAssignedToAsk(draft, ask.id).map((r) => r.name);
          return (
            <WidgetBlock
              key={ask.id}
              testId="feedback-compose-ask"
              rootClassName="feedback-compose-ask"
              tag={`Q${index + 1} · ${ask.label}`}
              hint={
                tier === 'full'
                  ? `${ASK_TYPE_HINTS[ask.type]} · ${joinNames(assigned)}`
                  : ASK_TYPE_HINTS[ask.type]
              }
              question={ask.description || ask.label}
              selectableQuestion
            >
              <FeedbackComposeAskPreview
                ask={ask}
                renderArtifact={host?.renderFeedbackArtifactPreview}
                renderArtifactPopover={host?.renderFeedbackArtifactPopover}
              />
            </WidgetBlock>
          );
        })}

        {/* Delivery — a collapsed line at Tier 1, fields at Tier 2. */}
        {showDelivery ? (
          <WidgetBlock
            tag="Delivery"
            tagTone="neutral"
            rootClassName="feedback-compose-delivery-block"
            testId="feedback-compose-delivery-block"
          >
            <FeedbackComposeDelivery
              visibility={draft.visibility}
              deadline={draft.deadline}
              quorumMode={draft.quorumMode}
              recipientCount={draft.recipients.length}
              now={now}
              onVisibilityChange={(visibility) =>
                update((current) => setVisibility(current, visibility))
              }
              onDeadlineChange={(deadline) => update((current) => setDeadline(current, deadline))}
              onQuorumModeChange={(mode) => update((current) => setQuorumMode(current, mode))}
              disabled={isSending}
            />
          </WidgetBlock>
        ) : (
          <div
            data-testid="feedback-compose-defaults"
            className="feedback-compose-defaults flex items-center gap-2 flex-wrap rounded-md border border-dashed border-nim px-3 py-2 text-[0.6875rem] text-nim-muted"
          >
            <span className="font-medium text-nim-faint">Defaults:</span>
            <span className="select-text">{describeComposeDefaults(draft, formatDeadline)}</span>
            <button
              type="button"
              data-testid="feedback-compose-more-options"
              onClick={() => update((current) => setSettingsExpanded(current, true))}
              className="ml-auto text-xs text-nim-primary bg-transparent border-none p-0 cursor-pointer hover:underline"
            >
              More options
            </button>
          </div>
        )}

        {pendingPublish.length > 0 && (
          <FeedbackComposePublishPrompt
            subjects={pendingPublish}
            confirmedSourceIds={draft.publishConfirmedSourceIds}
            recipientNames={recipientNames}
            forceExpanded={publishPromptForced}
            onConfirmAndSend={handleConfirmPublishAndSend}
            disabled={!canSend}
            destinationSubjectCount={destinationSubjects(draft).length}
            destination={draft.destination}
            onChangeDestination={
              host?.pickFeedbackDestination ? handleChangeDestination : undefined
            }
          />
        )}

        <WidgetFooter note={footerNote}>
          <WidgetActionButton
            variant="secondary"
            testId="feedback-compose-cancel"
            onClick={handleCancel}
            disabled={isSending}
          >
            Cancel
          </WidgetActionButton>
          <WidgetActionButton
            variant="primary"
            testId="feedback-compose-send"
            onClick={handlePrimary}
            disabled={plan.kind === 'blocked' || !canSend}
          >
            {isSending ? 'Sending…' : primaryLabel}
          </WidgetActionButton>
        </WidgetFooter>
      </InteractiveWidgetBody>
    </InteractiveWidgetCard>
  );
};
