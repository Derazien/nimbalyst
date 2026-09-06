import type { TeamInboxMaterializedDelivery } from "@nimbalyst/runtime/sync";

export function isAvailableAgentDelivery(
  delivery: TeamInboxMaterializedDelivery
): delivery is TeamInboxMaterializedDelivery & {
  source: NonNullable<TeamInboxMaterializedDelivery["source"]>;
  agentSessionIds: string[];
} {
  return (
    !delivery.unavailable &&
    !!delivery.source &&
    (delivery.agentSessionIds?.length ?? 0) > 0
  );
}

export function conversationIdForDelivery(
  delivery: TeamInboxMaterializedDelivery
): string | null {
  const source = delivery.source;
  if (!source) return null;
  if ("sourceId" in source) return source.sourceId;
  if (
    source.resourceKind === "document" &&
    delivery.agentWakePolicy === "documentDecision"
  )
    return `document:${source.resourceId}`;
  return source.resourceKind === "feedbackRequest"
    ? `feedback-request:${source.resourceId}`
    : null;
}

export function messageIdForDelivery(
  delivery: TeamInboxMaterializedDelivery
): string | null {
  const source = delivery.source;
  if (!source) return null;
  return "sourceEventId" in source ? source.sourceEventId : source.commentId;
}

export function policyKeyForDelivery(
  delivery: TeamInboxMaterializedDelivery
): string | null {
  return (
    delivery.agentWakePolicy ??
    ((delivery.agentSessionIds?.length ?? 0) > 0 ? "agentMention" : null)
  );
}
