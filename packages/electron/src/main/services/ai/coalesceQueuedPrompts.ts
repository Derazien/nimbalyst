/**
 * Drain-time coalescing of agent-authored queued prompts.
 *
 * The queue drains one row per turn. That is correct for a human at the
 * composer, but it makes orchestration unbounded: every child report and every
 * [Child Session Update] costs the parent a whole turn, so a parent driving
 * five children falls further behind with each one. Messages then arrive faster
 * than they drain and the parent ends up acting on notes that later rows in the
 * same queue already corrected.
 *
 * Merging at drain time rather than at enqueue time is deliberate. At drain we
 * have the freshest set, so supersession resolves for free -- the agent reads
 * "final, frozen", "frozen again", and "correction to last note" together and
 * acts once. Enqueue-time merging cannot know what is still coming, and the
 * renderer's composer-side merge additionally races the drain.
 *
 * Precedent for the shape: ClaudeCodeProvider.drainAndFormatPendingTeammateMessages
 * and AgentMentionDispatchService's inbox-wake grouping both already collapse
 * many notifications into one turn. This applies the same idea to the queue.
 */

import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

export interface CoalescibleQueuedPrompt {
  id: string;
  prompt: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

/**
 * Upper bound on rows folded into one turn, so a queue that has been building
 * for an hour cannot produce a single prompt too large to act on. The remainder
 * stays pending and drains on the next turn.
 */
export const MAX_COALESCED_PROMPTS = 20;

function isAgentAuthored(prompt: CoalescibleQueuedPrompt): boolean {
  return prompt.documentContext?.promptProvenance?.actor === 'agent';
}

/**
 * The leading run of rows safe to deliver as a single turn.
 *
 * Only agent-authored rows merge. A human row is a hard boundary in both
 * directions: it is never folded into agent chatter, and nothing behind it is
 * pulled forward past it, so "stop and do this instead" keeps its position in
 * the queue and its own turn.
 */
export function selectCoalescibleRun<T extends CoalescibleQueuedPrompt>(
  pending: readonly T[],
  maxBatch: number = MAX_COALESCED_PROMPTS,
): T[] {
  const head = pending[0];
  if (!head) return [];
  if (!isAgentAuthored(head)) return [head];

  const run: T[] = [head];
  for (let i = 1; i < pending.length && run.length < maxBatch; i++) {
    const next = pending[i];
    if (!isAgentAuthored(next)) break;
    run.push(next);
  }
  return run;
}

/**
 * Render a merged run. The header matters as much as the joining: without it an
 * agent reads a concatenation as one long instruction rather than as several
 * reports that arrived over time, and misses that the last one may retract the
 * first.
 */
export function formatCoalescedPrompt(prompts: readonly string[]): string {
  if (prompts.length === 0) return '';
  if (prompts.length === 1) return prompts[0];

  const header =
    `[${prompts.length} messages arrived while you were working, oldest first. ` +
    `Later messages may correct or supersede earlier ones -- read all of them before acting.]`;

  const body = prompts.map(
    (prompt, index) => `--- message ${index + 1} of ${prompts.length} ---\n${prompt}`,
  );

  return [header, ...body].join('\n\n');
}

/**
 * Collapse a claimed run into the single prompt the turn will deliver. The head
 * row supplies the document context because it is the one whose id becomes the
 * turn's `queuedPromptId`; attachments accumulate across the whole run so a
 * merged row never silently drops a child's uploaded file.
 */
export function mergeClaimedRun<T extends CoalescibleQueuedPrompt>(run: readonly T[]): T {
  const head = run[0];
  if (run.length === 1) return head;

  const attachments = run.flatMap((row) => row.attachments ?? []);

  return {
    ...head,
    prompt: formatCoalescedPrompt(run.map((row) => row.prompt)),
    attachments: attachments.length > 0 ? attachments : head.attachments ?? null,
  };
}
