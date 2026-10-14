import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';

/**
 * Put live sub-agent rows inside their agent's card when the card came from the
 * loaded snapshot.
 *
 * The stream accumulator projects only the events pushed since the session was
 * loaded. A background agent's card (its `subagent` event) usually predates the
 * load, so the projector cannot find the parent and leaves every later child at
 * the top level, where it shows up in the main conversation. This moves those
 * children into the card: the snapshot's children, any children the live card
 * already holds, and the live orphans, deduped by id with the newest copy
 * winning. The card is re-emitted as a live row so reconciliation replaces the
 * snapshot copy by id.
 */
export function nestLiveSubagentChildren(
  snapshot: readonly TranscriptViewMessage[],
  live: readonly TranscriptViewMessage[],
): TranscriptViewMessage[] {
  const snapshotCards = new Map<string, TranscriptViewMessage>();
  for (const message of snapshot) {
    if (message.type === 'subagent' && message.subagentId) snapshotCards.set(message.subagentId, message);
  }
  const liveCards = new Map<string, TranscriptViewMessage>();
  for (const message of live) {
    if (message.type === 'subagent' && message.subagentId) liveCards.set(message.subagentId, message);
  }

  const orphans = new Map<string, TranscriptViewMessage[]>();
  const topLevel: TranscriptViewMessage[] = [];
  for (const message of live) {
    const owner = message.type !== 'subagent' ? message.subagentId : null;
    if (owner && (liveCards.has(owner) || snapshotCards.has(owner))) {
      const list = orphans.get(owner) ?? [];
      list.push(message);
      orphans.set(owner, list);
    } else {
      topLevel.push(message);
    }
  }

  const affected = new Set<string>(orphans.keys());
  for (const id of liveCards.keys()) if (snapshotCards.has(id)) affected.add(id);
  if (affected.size === 0) return topLevel;

  const merged = new Map<string, TranscriptViewMessage>();
  for (const id of affected) {
    const base = liveCards.get(id) ?? snapshotCards.get(id)!;
    if (!base.subagent) continue;
    const byId = new Map<number, TranscriptViewMessage>();
    for (const child of snapshotCards.get(id)?.subagent?.childEvents ?? []) byId.set(child.id, child);
    for (const child of liveCards.get(id)?.subagent?.childEvents ?? []) byId.set(child.id, child);
    for (const child of orphans.get(id) ?? []) byId.set(child.id, child);
    const childEvents = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
    merged.set(id, { ...base, subagent: { ...base.subagent, childEvents } });
  }

  const out = topLevel.map((message) =>
    message.type === 'subagent' && message.subagentId && merged.has(message.subagentId)
      ? merged.get(message.subagentId)!
      : message,
  );
  for (const [id, card] of merged) {
    if (!liveCards.has(id)) out.push(card);
  }
  return out;
}
