/**
 * Pure draft logic for the feedback-request compose surface.
 *
 * Two things live here rather than in the widget, because they are the real
 * behaviour of this slice and a reader cannot see either one on screen:
 *
 * 1. **Tier is derived, never stored.** Tier 1 (quick ask) and Tier 2 (full
 *    request) are the same draft rendered at two disclosure levels. Promotion
 *    is a pure function of content -- a second recipient, a deadline, or a
 *    subject that is not team-visible -- so there is no mode flag to get out of
 *    sync, and demoting cannot discard what the author already entered: the
 *    fields simply stop being shown while their values stay in the draft.
 * 2. **Publishing an unshared subject is gated on an explicit confirmation
 *    that names the exact subjects.** The confirmation records the subject ids
 *    it covered, so adding another unshared subject afterwards re-blocks
 *    sending instead of silently riding along on a stale confirmation.
 *
 * Types come from `@nimbalyst/collab-protocol`; this module adds only the
 * compose-time view model (a subject's display label and shared flag are
 * presentation, not wire format) and carries no transport of its own.
 */

import type {
  FeedbackArtifact,
  FeedbackAsk,
  FeedbackAskAssignment,
  FeedbackRequestRecipient,
  FeedbackRequestVisibility,
  FeedbackRequestWakePolicy,
  ResourceRef,
} from '@nimbalyst/collab-protocol';

// ============================================================
// Draft model
// ============================================================

/**
 * A subject as the author sees it while composing: the wire `ResourceRef` plus
 * the label, context line, and team-visibility flag needed to render the
 * shared/not-shared dot and the publish prompt.
 */
export interface FeedbackComposeSubject {
  ref: ResourceRef;
  /** File name or title shown on the artifact chip. */
  label: string;
  /** Muted second line, e.g. the containing folder. */
  context?: string;
  /** True when the subject is already visible to the recipients' team. */
  shared: boolean;
}

/**
 * The team-files folder every file subject in this request gets published into.
 *
 * One destination per request, not one per subject: the author is sending a set
 * of artifacts to be looked at together, and splitting them across folders is a
 * question nobody has asked for.
 *
 * `pendingFolder` is a folder the author named but that does not exist yet. It
 * is deliberately NOT created when they name it -- the host creates it in its
 * publish pass, right before the first document that needs it -- because
 * abandoning a send must leave the team exactly as it was. The share dialog
 * creates folders eagerly and can strand an empty one; this path does not.
 */
export interface FeedbackComposeDestination {
  /** null is the team-files root. */
  folderId: string | null;
  /** Display path for the collapsed line. Empty string reads as the root. */
  path: string;
  pendingFolder?: { name: string; parentFolderId: string | null };
}

/**
 * Where an unchosen destination lands.
 *
 * Not `lastSharedFolderId`. That value is a recency memory of an unrelated
 * action -- share one spec into `Product/` and the next three mockups an agent
 * asks about follow it there, which nobody decided. A request the author did not
 * place goes somewhere named after what it is.
 *
 * Resolving this name to a folder id needs the team's folder index, which lives
 * in the host, so the draft carries `undefined` and the host resolves it at
 * publish time. That also keeps the collapsed line paintable with no round trip.
 */
export const FEEDBACK_DEFAULT_DESTINATION_NAME = 'Feedback requests';

/** Who counts as "enough answers to wake the session". */
export type FeedbackComposeQuorumMode = 'first' | 'all';

export interface FeedbackComposeDraft {
  /** Existing shared markdown subject approved as the host; absent creates a decision document. */
  hostDocumentId?: string;
  /** Stable id for this draft; also the draft-atom key. */
  draftId: string;
  /** The org the request will be created in. */
  orgId: string;
  subjects: FeedbackComposeSubject[];
  asks: FeedbackAsk[];
  recipients: FeedbackRequestRecipient[];
  assignments: FeedbackAskAssignment[];
  visibility: FeedbackRequestVisibility;
  quorumMode: FeedbackComposeQuorumMode;
  /** Epoch ms, or undefined for no deadline. */
  deadline?: number;
  /**
   * Subject `sourceId`s the author explicitly agreed to publish. Cleared
   * whenever the unshared set changes, so a confirmation can never cover a
   * subject the author was not shown.
   */
  publishConfirmedSourceIds: string[];
  /**
   * Where file subjects get published. Absent means the author never opened the
   * picker, which is the common case and resolves to
   * `FEEDBACK_DEFAULT_DESTINATION_NAME` in the host.
   */
  destination?: FeedbackComposeDestination;
  /**
   * Tier 1 shows delivery settings as one collapsed line; this reveals them in
   * place. It is presentation only -- expanding does NOT promote the tier, and
   * the tier does not depend on it.
   */
  settingsExpanded: boolean;
}

/** The protocol currently defines exactly one wake rule. */
export const FEEDBACK_COMPOSE_WAKE_POLICY: FeedbackRequestWakePolicy = 'quorumOrClose';

export function createEmptyFeedbackComposeDraft(
  draftId: string,
  orgId = '',
): FeedbackComposeDraft {
  return {
    draftId,
    orgId,
    subjects: [],
    asks: [],
    recipients: [],
    assignments: [],
    visibility: 'hiddenUntilAnswered',
    quorumMode: 'all',
    publishConfirmedSourceIds: [],
    settingsExpanded: false,
  };
}

// ============================================================
// Tier derivation
// ============================================================

export type FeedbackComposeTier = 'quick' | 'full';

export type FeedbackComposeTierPromotionReason =
  | 'multipleRecipients'
  | 'deadline'
  | 'unsharedSubject';

/**
 * Every reason the draft is currently at Tier 2, in the order the plan lists
 * them. Empty means Tier 1.
 */
export function feedbackComposeTierPromotionReasons(
  draft: FeedbackComposeDraft,
): FeedbackComposeTierPromotionReason[] {
  const reasons: FeedbackComposeTierPromotionReason[] = [];
  if (draft.recipients.length > 1) reasons.push('multipleRecipients');
  if (draft.deadline !== undefined) reasons.push('deadline');
  if (draft.subjects.some((subject) => !subject.shared)) reasons.push('unsharedSubject');
  return reasons;
}

export function feedbackComposeTier(draft: FeedbackComposeDraft): FeedbackComposeTier {
  return feedbackComposeTierPromotionReasons(draft).length > 0 ? 'full' : 'quick';
}

// ============================================================
// Assignment helpers
// ============================================================

export function isAskAssignedTo(
  draft: FeedbackComposeDraft,
  askId: string,
  userId: string,
): boolean {
  return draft.assignments.some(
    (assignment) =>
      assignment.askId === askId &&
      assignment.target.kind === 'user' &&
      assignment.target.userId === userId,
  );
}

export function asksAssignedTo(draft: FeedbackComposeDraft, userId: string): FeedbackAsk[] {
  return draft.asks.filter((ask) => isAskAssignedTo(draft, ask.id, userId));
}

export function recipientsAssignedToAsk(
  draft: FeedbackComposeDraft,
  askId: string,
): FeedbackRequestRecipient[] {
  return draft.recipients.filter((recipient) => isAskAssignedTo(draft, askId, recipient.userId));
}

// ============================================================
// Mutators (pure; the widget writes the result back to its draft atom)
// ============================================================

/**
 * Confirmations are scoped to the exact unshared set the author was shown, so
 * any change to that set invalidates them.
 */
function withRevalidatedPublishConfirmation(
  draft: FeedbackComposeDraft,
): FeedbackComposeDraft {
  const stillUnshared = new Set(unsharedSubjects(draft).map((subject) => subject.ref.sourceId));
  const kept = draft.publishConfirmedSourceIds.filter((id) => stillUnshared.has(id));
  return kept.length === draft.publishConfirmedSourceIds.length
    ? draft
    : { ...draft, publishConfirmedSourceIds: kept };
}

export function addRecipient(
  draft: FeedbackComposeDraft,
  recipient: FeedbackRequestRecipient,
): FeedbackComposeDraft {
  if (draft.recipients.some((existing) => existing.userId === recipient.userId)) {
    return draft;
  }
  // A new recipient with nothing to answer is not a useful default; give them
  // every ask and let the author narrow it with the per-person chips.
  const assignments = [
    ...draft.assignments,
    ...draft.asks.map((ask) => ({
      askId: ask.id,
      target: { kind: 'user' as const, userId: recipient.userId },
    })),
  ];
  return { ...draft, recipients: [...draft.recipients, recipient], assignments };
}

/**
 * Drops the person and their assignments. Asks they were the only recipient of
 * are kept -- an ask is authored content, and orphaning it is visible in the
 * surface (it blocks send) rather than silently deleting the author's work.
 */
export function removeRecipient(
  draft: FeedbackComposeDraft,
  userId: string,
): FeedbackComposeDraft {
  return {
    ...draft,
    recipients: draft.recipients.filter((recipient) => recipient.userId !== userId),
    assignments: draft.assignments.filter(
      (assignment) =>
        !(assignment.target.kind === 'user' && assignment.target.userId === userId),
    ),
  };
}

export function toggleAssignment(
  draft: FeedbackComposeDraft,
  askId: string,
  userId: string,
): FeedbackComposeDraft {
  if (isAskAssignedTo(draft, askId, userId)) {
    return {
      ...draft,
      assignments: draft.assignments.filter(
        (assignment) =>
          !(
            assignment.askId === askId &&
            assignment.target.kind === 'user' &&
            assignment.target.userId === userId
          ),
      ),
    };
  }
  return {
    ...draft,
    assignments: [...draft.assignments, { askId, target: { kind: 'user', userId } }],
  };
}

export function setDeadline(
  draft: FeedbackComposeDraft,
  deadline: number | undefined,
): FeedbackComposeDraft {
  return { ...draft, deadline };
}

export function setVisibility(
  draft: FeedbackComposeDraft,
  visibility: FeedbackRequestVisibility,
): FeedbackComposeDraft {
  return { ...draft, visibility };
}

export function setQuorumMode(
  draft: FeedbackComposeDraft,
  quorumMode: FeedbackComposeQuorumMode,
): FeedbackComposeDraft {
  return { ...draft, quorumMode };
}

export function setSettingsExpanded(
  draft: FeedbackComposeDraft,
  settingsExpanded: boolean,
): FeedbackComposeDraft {
  return { ...draft, settingsExpanded };
}

export function removeSubject(
  draft: FeedbackComposeDraft,
  sourceId: string,
): FeedbackComposeDraft {
  return withRevalidatedPublishConfirmation({
    ...draft,
    subjects: draft.subjects.filter((subject) => subject.ref.sourceId !== sourceId),
  });
}

/**
 * Records the author's explicit agreement to publish the subjects they were
 * shown. Nothing else in this module sets `publishConfirmedSourceIds`.
 */
export function confirmPublish(draft: FeedbackComposeDraft): FeedbackComposeDraft {
  return {
    ...draft,
    publishConfirmedSourceIds: unsharedSubjects(draft).map((subject) => subject.ref.sourceId),
  };
}

// ============================================================
// Publish gate + submit plan
// ============================================================

export function unsharedSubjects(draft: FeedbackComposeDraft): FeedbackComposeSubject[] {
  return draft.subjects.filter((subject) => !subject.shared);
}

/**
 * The subjects a destination actually applies to.
 *
 * A tracker is published by flipping its own visibility bit and never lands in
 * a folder, so a request whose only unshared subject is a tracker must not be
 * shown a destination -- it would name a place nothing goes.
 */
export function destinationSubjects(draft: FeedbackComposeDraft): FeedbackComposeSubject[] {
  return unsharedSubjects(draft).filter((subject) => subject.ref.kind === 'file');
}

export function setDestination(
  draft: FeedbackComposeDraft,
  destination: FeedbackComposeDestination,
): FeedbackComposeDraft {
  return { ...draft, destination };
}

/**
 * What the collapsed line calls the destination.
 *
 * Absent is the unchosen default, not the root: those are different states and
 * conflating them would tell the author their mockups land at the top of team
 * files when they do not.
 */
export function describeDestination(destination?: FeedbackComposeDestination): string {
  if (!destination) return FEEDBACK_DEFAULT_DESTINATION_NAME;
  if (destination.pendingFolder) {
    const { name, parentFolderId } = destination.pendingFolder;
    return parentFolderId && destination.path ? `${destination.path} / ${name}` : name;
  }
  // A persisted folder id can outlive the folder itself; the host reports that
  // as a root selection rather than a name nobody can find.
  return destination.path ? destination.path.split('/').join(' / ') : 'Team files';
}

export type FeedbackComposeBlockedReason =
  | 'noRecipients'
  | 'noAsks'
  | 'unassignedAsk'
  | 'unassignedRecipient';

export type FeedbackComposeSubmitPlan =
  | { kind: 'blocked'; reason: FeedbackComposeBlockedReason }
  | { kind: 'needsPublishConfirmation'; subjects: FeedbackComposeSubject[] }
  | { kind: 'ready'; publishSubjectRefs: ResourceRef[] };

/**
 * What pressing the primary button may do right now. The widget calls the host
 * only for `ready`; every other result is a reason not to send yet.
 */
export function feedbackComposeSubmitPlan(
  draft: FeedbackComposeDraft,
): FeedbackComposeSubmitPlan {
  if (draft.recipients.length === 0) return { kind: 'blocked', reason: 'noRecipients' };
  if (draft.asks.length === 0) return { kind: 'blocked', reason: 'noAsks' };
  if (draft.asks.some((ask) => recipientsAssignedToAsk(draft, ask.id).length === 0)) {
    return { kind: 'blocked', reason: 'unassignedAsk' };
  }
  if (draft.recipients.some((recipient) => asksAssignedTo(draft, recipient.userId).length === 0)) {
    return { kind: 'blocked', reason: 'unassignedRecipient' };
  }

  const pending = unsharedSubjects(draft);
  const confirmed = new Set(draft.publishConfirmedSourceIds);
  const unconfirmed = pending.filter((subject) => !confirmed.has(subject.ref.sourceId));
  if (unconfirmed.length > 0) {
    return { kind: 'needsPublishConfirmation', subjects: pending };
  }

  return { kind: 'ready', publishSubjectRefs: pending.map((subject) => subject.ref) };
}

export const FEEDBACK_COMPOSE_BLOCKED_MESSAGES: Record<FeedbackComposeBlockedReason, string> = {
  noRecipients: 'Add someone to ask.',
  noAsks: 'Add at least one question.',
  unassignedAsk: 'Every question needs at least one person assigned to it.',
  unassignedRecipient: 'Everyone on the list needs at least one question.',
};

// ============================================================
// Send payload
// ============================================================

export interface FeedbackComposeSendPayload {
  hostDocumentId?: string;
  draftId: string;
  orgId: string;
  /**
   * Carries the author's label, not just the ref. Publishing rewrites a `file`
   * ref to the created `document`, so a recipient handed only refs would have
   * nothing to render but an opaque document id.
   */
  subjects: FeedbackArtifact[];
  asks: FeedbackAsk[];
  recipients: FeedbackRequestRecipient[];
  assignments: FeedbackAskAssignment[];
  visibility: FeedbackRequestVisibility;
  wakePolicy: FeedbackRequestWakePolicy;
  quorum: { requiredRecipientCount: number };
  deadline?: number;
  /** Subjects the author confirmed publishing; empty when nothing needs it. */
  publishSubjectRefs: ResourceRef[];
  /**
   * Where those subjects land. Absent hands the host the default, which is what
   * it resolves when the author never opened the picker.
   */
  destination?: FeedbackComposeDestination;
}

export function requiredRecipientCount(draft: FeedbackComposeDraft): number {
  return draft.quorumMode === 'first' ? 1 : Math.max(1, draft.recipients.length);
}

export function feedbackComposeSendPayload(
  draft: FeedbackComposeDraft,
  publishSubjectRefs: ResourceRef[],
): FeedbackComposeSendPayload {
  return {
    draftId: draft.draftId,
    orgId: draft.orgId,
    ...(draft.hostDocumentId ? { hostDocumentId: draft.hostDocumentId } : {}),
    subjects: draft.subjects.map((subject) => ({
      ref: subject.ref,
      label: subject.label,
      ...(subject.context ? { context: subject.context } : {}),
    })),
    asks: draft.asks,
    recipients: draft.recipients,
    assignments: draft.assignments,
    visibility: draft.visibility,
    wakePolicy: FEEDBACK_COMPOSE_WAKE_POLICY,
    quorum: { requiredRecipientCount: requiredRecipientCount(draft) },
    deadline: draft.deadline,
    publishSubjectRefs,
    // Only when something is actually being published. A request that publishes
    // nothing has no destination, and sending one would have the host resolve
    // (and possibly create) a folder for zero documents.
    ...(publishSubjectRefs.length > 0 && draft.destination
      ? { destination: draft.destination }
      : {}),
  };
}

// ============================================================
// Tier 1 collapsed summary
// ============================================================

export function describeVisibility(visibility: FeedbackRequestVisibility): string {
  return visibility === 'open'
    ? 'answers visible to everyone asked'
    : 'answers visible after each person responds';
}

export function describeWake(draft: FeedbackComposeDraft): string {
  if (draft.recipients.length <= 1) {
    const name = draft.recipients[0]?.name;
    return name ? `this session resumes when ${name} replies` : 'this session resumes on the reply';
  }
  return draft.quorumMode === 'first'
    ? 'this session resumes on the first reply, or when you close the request'
    : 'this session resumes when everyone replies, or when you close the request';
}

/**
 * The single collapsed line Tier 1 shows instead of delivery fields. It reports
 * the draft's actual values rather than a fixed sentence, so a setting the
 * author changed before demoting back to Tier 1 is still stated honestly.
 */
export function describeComposeDefaults(
  draft: FeedbackComposeDraft,
  formatDeadline: (deadline: number) => string,
): string {
  const parts = [
    'sent as a direct message',
    describeVisibility(draft.visibility),
    draft.deadline === undefined ? 'no deadline' : `due ${formatDeadline(draft.deadline)}`,
    describeWake(draft),
  ];
  return parts.join(' · ');
}
