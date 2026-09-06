import type {
  AgentWakeCandidate,
  AgentWakePolicyContext,
} from "./AgentMentionDispatchService";

export function documentDecisionWakePolicy(context: AgentWakePolicyContext) {
  const wake = context.candidates.some((candidate) => {
    const trigger = candidate.policyMetadata?.trigger;
    return (
      candidate.resourceKind === "document" &&
      typeof candidate.resourceId === "string" &&
      typeof candidate.policyMetadata?.blockId === "string" &&
      (trigger === "quorum" ||
        trigger === "closed" ||
        (typeof trigger === "string" && trigger.startsWith("nudge:")))
    );
  });
  return {
    wake,
    reason: wake
      ? "document decision reached quorum, settled, or was explicitly nudged"
      : "no actionable document decision transition",
  };
}

export function documentDecisionWakePrompt(
  orgId: string,
  candidates: AgentWakeCandidate[]
): string {
  const documentId = candidates[0].resourceId!;
  const uri = `collab://org:${orgId}:doc:${documentId}`;
  return [
    "A decision in your shared document has new feedback.",
    `Read the current document with readCollabDoc using filePath ${uri} and includeDecisionState: true.`,
    ...candidates.map(
      (candidate) =>
        `- Block ${candidate.policyMetadata?.blockId}: ${candidate.policyMetadata?.trigger}`
    ),
    "",
    "The document is authoritative. Read its current decision blocks and discussion before continuing; Inbox notifications may be older than the current outcome.",
    `Read its discussion with readCollabDocComments using filePath ${uri}.`,
    "Quorum is information for the human, not permission to seal. Agent recommendations never count as human votes. Continue only the work already authorized for this session and preserve the attributed outcome in the document.",
  ].join("\n");
}
