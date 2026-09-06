import yaml from 'js-yaml';
import { buildCollabUri, type FeedbackAsk } from '@nimbalyst/collab-protocol';
import type { FeedbackComposeSendPayload } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/feedback/feedbackComposeDraft';
import { parseDecisionFence, serializeDecisionFence } from '@nimbalyst/runtime/editor/plugins/DecisionPlugin/decisionFence';

export interface AuthoredDecisionBlock { blockId: string; askId: string; content: string; recipientIds: string[]; quorum: number }

function part(value: string): string {
  return encodeURIComponent(value);
}

/** Draft and ask ids make a failed or replayed human send address the same block. */
export function decisionBlocksForFeedback(payload: FeedbackComposeSendPayload): AuthoredDecisionBlock[] {
  if (!payload.draftId || payload.asks.length === 0) throw new Error('A feedback draft needs an id and at least one question.');
  const ids = new Set<string>();
  return payload.asks.map((ask: FeedbackAsk) => {
    const blockId = `dcn-${part(payload.draftId)}-${part(ask.id)}`;
    if (ids.has(blockId)) throw new Error('Each question must have a unique id.');
    ids.add(blockId);
    const recipientIds = [...new Set(payload.assignments.filter((assignment) => assignment.askId === ask.id).map((assignment) => assignment.target.userId))];
    if (recipientIds.length === 0 || recipientIds.some((id) => !payload.recipients.some((person) => person.userId === id))) {
      throw new Error('Every question must be assigned to resolved teammates.');
    }
    const raw: Record<string, unknown> = {
      ...ask, id: blockId, ask: ask.label, asked: recipientIds, visibility: payload.visibility, feedbackDraftId: payload.draftId, feedbackAskId: ask.id,
      ...(payload.deadline ? { deadline: payload.deadline } : {}),
    };
    delete raw.label;
    delete raw.artifacts;
    if (ask.type === 'editText') { raw.seed = ask.initialText; delete raw.initialText; }
    if ('artifacts' in ask && ask.artifacts?.length) {
      const key = ask.type === 'singleSelect' ? 'options' : 'items';
      const entries = raw[key] as Array<Record<string, unknown>>;
      raw[key] = entries.map((entry) => {
        const artifact = ask.artifacts?.find((candidate) => candidate.entryId === entry.id);
        if (!artifact) return entry;
        if (artifact.ref.kind !== 'document' || artifact.ref.orgId !== payload.orgId) throw new Error('Option previews must be shared documents in this organization before sending.');
        return { ...entry, artifact: buildCollabUri(artifact.ref.orgId, artifact.ref.sourceId) };
      });
    }
    const source = parseDecisionFence(yaml.dump(raw, { lineWidth: -1, noRefs: true }));
    if (!source) throw new Error(`The question ${ask.label} could not be created.`);
    return { blockId, askId: ask.id, content: serializeDecisionFence(source), recipientIds, quorum: Math.min(payload.quorum.requiredRecipientCount, recipientIds.length) };
  });
}
