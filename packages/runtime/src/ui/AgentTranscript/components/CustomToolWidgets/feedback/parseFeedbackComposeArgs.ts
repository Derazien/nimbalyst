/**
 * Defence-in-depth parsing of the cross-user ask tool's arguments into a
 * compose draft.
 *
 * The agent drafts this request, and a tool call persisted in the transcript
 * can carry any shape at all -- including a malformed one from an older
 * session. Everything that cannot render is dropped rather than thrown, in the
 * same spirit as `parseQuestions` in AskUserQuestionWidget: the author still
 * gets a draft they can fix in place.
 *
 * A subject is treated as NOT shared unless the tool says otherwise, so a
 * missing or unparseable flag can only ever over-warn.
 */

import type {
  FeedbackAsk,
  FeedbackAskArtifact,
  FeedbackAskAssignment,
  FeedbackRequestRecipient,
  FeedbackRequestVisibility,
  ResourceRef,
} from '@nimbalyst/collab-protocol';
import {
  createEmptyFeedbackComposeDraft,
  type FeedbackComposeDraft,
  type FeedbackComposeSubject,
} from './feedbackComposeDraft';

type Unknown = Record<string, unknown>;

export type RequestFeedbackToolOutcome = {
  status:
    | 'ambiguousRecipient'
    | 'recipientNotFound'
    | 'noTeam'
    | 'subjectNotFound'
    | 'invalidDraft';
  message: string;
};

export type ParsedRequestFeedbackToolResult =
  | { status: 'draftReady'; draft: FeedbackComposeDraft }
  | RequestFeedbackToolOutcome;

function asRecord(value: unknown): Unknown | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Unknown) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const RESOURCE_REF_KINDS = new Set([
  'tracker',
  'document',
  'session',
  'file',
  'commit',
  'pullRequest',
  'conversation',
  'feedbackRequest',
]);

function parseResourceRef(value: unknown, fallbackOrgId: string): ResourceRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = asString(record.kind);
  const sourceId = asString(record.sourceId);
  if (!kind || !sourceId || !RESOURCE_REF_KINDS.has(kind)) return null;
  const orgId = asString(record.orgId) ?? fallbackOrgId;
  const ref: ResourceRef = { orgId, kind: kind as ResourceRef['kind'], sourceId };
  const projectId = asString(record.projectId);
  if (projectId) ref.projectId = projectId;
  return ref;
}

function parseSubject(value: unknown, fallbackOrgId: string): FeedbackComposeSubject | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = parseResourceRef(record.ref ?? record, fallbackOrgId);
  if (!ref) return null;
  return {
    ref,
    label: asString(record.label) ?? ref.sourceId,
    context: asString(record.context) ?? undefined,
    shared: record.shared === true,
  };
}

/**
 * Per-entry artifacts, which is what makes "pick one of these three mockups" a
 * visual question rather than three strings.
 *
 * Dropping these was invisible in the worst way: the ask still rendered, every
 * option still had its label and description, and the only symptom was that the
 * author reviewing a draft saw no mockups -- with nothing on screen to suggest
 * the binding had been silently discarded on the way in.
 *
 * An artifact naming an entry that does not exist is discarded rather than
 * kept: it can never be rendered, and carrying it would put a resource in the
 * publish list that no question refers to.
 */
function parseAskArtifacts(
  value: unknown,
  entryIds: ReadonlySet<string>,
  fallbackOrgId: string,
): FeedbackAskArtifact[] {
  if (!Array.isArray(value)) return [];
  const parsed: FeedbackAskArtifact[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record) continue;
    const entryId = asString(record.entryId);
    if (!entryId || !entryIds.has(entryId)) continue;
    const ref = parseResourceRef(record.ref ?? record, fallbackOrgId);
    if (!ref) continue;
    parsed.push({
      entryId,
      ref,
      label: asString(record.label) ?? ref.sourceId,
      context: asString(record.context) ?? undefined,
    });
  }
  return parsed;
}

function parseSelectOptions(value: unknown): Array<{ id: string; label: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  const parsed: Array<{ id: string; label: string; description?: string }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asString(record.id);
    const label = asString(record.label);
    if (!id || !label) continue;
    parsed.push({ id, label, description: asString(record.description) ?? undefined });
  }
  return parsed;
}

function parseItems(
  value: unknown,
): Array<{ id: string; title: string; subtitle?: string; badge?: string; removable?: boolean; defaultChecked?: boolean }> {
  if (!Array.isArray(value)) return [];
  const parsed: Array<{
    id: string;
    title: string;
    subtitle?: string;
    badge?: string;
    removable?: boolean;
    defaultChecked?: boolean;
  }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asString(record.id);
    const title = asString(record.title);
    if (!id || !title) continue;
    parsed.push({
      id,
      title,
      subtitle: asString(record.subtitle) ?? undefined,
      badge: asString(record.badge) ?? undefined,
      removable: record.removable === true ? true : undefined,
      defaultChecked: record.defaultChecked === true ? true : undefined,
    });
  }
  return parsed;
}

/** Returns null for anything that cannot render as one of the six ask types. */
function parseAsk(value: unknown, fallbackOrgId: string): FeedbackAsk | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id);
  const label = asString(record.label);
  const type = asString(record.type);
  if (!id || !label || !type) return null;
  const description = asString(record.description) ?? '';

  switch (type) {
    case 'singleSelect': {
      const options = parseSelectOptions(record.options);
      if (options.length === 0) return null;
      const artifacts = parseAskArtifacts(
        record.artifacts,
        new Set(options.map((option) => option.id)),
        fallbackOrgId,
      );
      return {
        type: 'singleSelect',
        id,
        label,
        description,
        options,
        allowOther: record.allowOther === true ? true : undefined,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    }
    case 'multiSelect': {
      const items = parseItems(record.items);
      if (items.length === 0) return null;
      return {
        type: 'multiSelect',
        id,
        label,
        description,
        items,
        minSelected: asNumber(record.minSelected) ?? undefined,
        maxSelected: asNumber(record.maxSelected) ?? undefined,
      };
    }
    case 'reorder': {
      const items = parseItems(record.items);
      if (items.length === 0) return null;
      const artifacts = parseAskArtifacts(
        record.artifacts,
        new Set(items.map((item) => item.id)),
        fallbackOrgId,
      );
      return {
        type: 'reorder',
        id,
        label,
        description,
        items,
        minItems: asNumber(record.minItems) ?? undefined,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    }
    case 'editText': {
      const format = asString(record.format);
      return {
        type: 'editText',
        id,
        label,
        description,
        initialText: typeof record.initialText === 'string' ? record.initialText : '',
        format: format === 'plain' || format === 'markdown' ? format : undefined,
        placeholder: asString(record.placeholder) ?? undefined,
        minLength: asNumber(record.minLength) ?? undefined,
        maxLength: asNumber(record.maxLength) ?? undefined,
      };
    }
    case 'confirm':
      return {
        type: 'confirm',
        id,
        label,
        description,
        defaultValue: typeof record.defaultValue === 'boolean' ? record.defaultValue : undefined,
      };
    case 'rating': {
      const min = asNumber(record.min) ?? 1;
      const max = asNumber(record.max) ?? 5;
      if (max <= min) return null;
      return {
        type: 'rating',
        id,
        label,
        description,
        min,
        max,
        step: asNumber(record.step) ?? undefined,
        initialValue: asNumber(record.initialValue) ?? undefined,
        minLabel: asString(record.minLabel) ?? undefined,
        maxLabel: asString(record.maxLabel) ?? undefined,
      };
    }
    default:
      return null;
  }
}

function parseRecipient(value: unknown): FeedbackRequestRecipient | null {
  const record = asRecord(value);
  if (!record) return null;
  const userId = asString(record.userId);
  if (!userId) return null;
  return { userId, name: asString(record.name) ?? userId };
}

function parseAssignments(
  value: unknown,
  askIds: Set<string>,
  userIds: Set<string>,
): FeedbackAskAssignment[] {
  if (!Array.isArray(value)) return [];
  const parsed: FeedbackAskAssignment[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const askId = asString(record.askId);
    const target = asRecord(record.target);
    const userId = target ? asString(target.userId) : null;
    if (!askId || !userId) continue;
    if (!askIds.has(askId) || !userIds.has(userId)) continue;
    if (parsed.some((a) => a.askId === askId && a.target.userId === userId)) continue;
    parsed.push({ askId, target: { kind: 'user', userId } });
  }
  return parsed;
}

/**
 * Builds the compose draft. Returns null only when there is nothing renderable
 * at all -- no asks -- because a card with no questions is not a draft the
 * author can review or repair.
 */
export function parseFeedbackComposeArgs(
  args: unknown,
  fallbackDraftId: string,
): FeedbackComposeDraft | null {
  const record = asRecord(args);
  if (!record) return null;

  const orgId = asString(record.orgId) ?? '';
  const asks = Array.isArray(record.asks)
    ? record.asks
        .map((ask) => parseAsk(ask, orgId))
        .filter((ask): ask is FeedbackAsk => ask !== null)
    : [];
  if (asks.length === 0) return null;

  const recipients = Array.isArray(record.recipients)
    ? record.recipients
        .map(parseRecipient)
        .filter((recipient): recipient is FeedbackRequestRecipient => recipient !== null)
    : [];

  const askIds = new Set(asks.map((ask) => ask.id));
  const userIds = new Set(recipients.map((recipient) => recipient.userId));
  let assignments = parseAssignments(record.assignments, askIds, userIds);
  if (assignments.length === 0) {
    // No explicit split means everyone answers everything; the per-person chips
    // are how the author narrows it.
    assignments = recipients.flatMap((recipient) =>
      asks.map((ask) => ({
        askId: ask.id,
        target: { kind: 'user' as const, userId: recipient.userId },
      })),
    );
  }

  const subjects = Array.isArray(record.subjects)
    ? record.subjects
        .map((subject) => parseSubject(subject, orgId))
        .filter((subject): subject is FeedbackComposeSubject => subject !== null)
    : [];

  const visibility = record.visibility === 'open' ? 'open' : 'hiddenUntilAnswered';

  return {
    ...createEmptyFeedbackComposeDraft(asString(record.requestId) ?? fallbackDraftId, orgId),
    subjects,
    ...(asString(record.hostDocumentId) ? { hostDocumentId: asString(record.hostDocumentId)! } : {}),
    asks,
    recipients,
    assignments,
    visibility: visibility as FeedbackRequestVisibility,
    quorumMode: record.quorumMode === 'first' ? 'first' : 'all',
    deadline: asNumber(record.deadline) ?? undefined,
  };
}

function parseToolResultRecord(value: unknown): Unknown | null {
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (!record) return null;
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => asRecord(entry))
      .find((entry) => typeof entry?.text === 'string')?.text;
    return typeof text === 'string' ? parseToolResultRecord(text) : null;
  }
  return record;
}

/**
 * RequestFeedback returns immediately with either a normalized draft or an
 * actionable directory/sharing/validation outcome. A draft result is pending
 * author approval; it is not evidence that anything was sent.
 */
export function parseRequestFeedbackToolResult(
  value: unknown,
  fallbackDraftId: string,
): ParsedRequestFeedbackToolResult | null {
  const record = parseToolResultRecord(value);
  const status = record ? asString(record.status) : null;
  if (!record || !status) return null;
  if (status === 'draftReady') {
    const draft = parseFeedbackComposeArgs(record.draft, fallbackDraftId);
    return draft ? { status, draft } : null;
  }
  if (
    status === 'ambiguousRecipient'
    || status === 'recipientNotFound'
    || status === 'noTeam'
    || status === 'subjectNotFound'
    || status === 'invalidDraft'
  ) {
    return {
      status,
      message: asString(record.message) ?? 'The feedback request draft could not be prepared.',
    };
  }
  return null;
}
