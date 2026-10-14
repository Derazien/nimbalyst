/**
 * Pure core for flushing the next queued prompt into a `claude-code-cli` session
 * (NIM-806 — input integration / queued prompts).
 *
 * The SDK path flushes its queue via `ai:triggerQueueProcessing` → the in-process
 * send loop. The CLI has no such loop — it's driven by the PTY — so when a CLI
 * turn ends (the PID watcher's authoritative `idle` transition), we claim the
 * oldest pending prompt and submit it to the PTY via the shared
 * `submitClaudeCliPrompt` composer (so its attachments flush identically to an
 * immediate send). Writing the prompt restarts the CLI (idle → running → idle),
 * and the next idle flushes the following prompt, so the queue drains one prompt
 * per turn with no extra scheduling.
 *
 * Kept dependency-free (store/submit injected) so it unit-tests without pulling
 * in electron/RepositoryManager. Production wiring lives in
 * `claudeCliQueueFlushSingleton.ts`.
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import type { ClaudeCliDocumentContext } from './claudeCliPromptComposer';
import { readCliTerminalQueueMarker } from './claudeCliTerminalQueue';

export interface FlushQueuedPrompt {
  id: string;
  prompt?: string | null;
  attachments?: unknown[] | null;
  /** Active-doc/selection context captured at queue time (NIM-818). */
  documentContext?: ClaudeCliDocumentContext | null;
}

export interface FlushClaudeCliQueueDeps {
  listPending: (sessionId: string) => Promise<FlushQueuedPrompt[]>;
  claim: (promptId: string) => Promise<FlushQueuedPrompt | null>;
  complete: (promptId: string) => Promise<void>;
  fail: (promptId: string, errorMessage: string) => Promise<void>;
  submit: (input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    attachments?: ChatAttachment[];
    documentContext?: ClaudeCliDocumentContext | null;
  }) => Promise<{ submitted: boolean }>;
  /**
   * Tell the renderer a queued prompt has left the pending queue, so it drops
   * the row from the queued-prompts UI (NIM-830). Mirrors the SDK dispatcher's
   * `ai:promptClaimed`. Fired right after a successful claim.
   */
  notifyClaimed?: (promptId: string) => void;
  /**
   * True while a prompt we already submitted is still draining into the PTY. The
   * CLI has not started its turn yet, so the PID file still reads idle — flushing
   * on that stale idle writes a second prompt into the same terminal, where it
   * lands behind the first turn's Enter and sits unsent. See
   * `claudeCliSubmitLatch`.
   */
  isSubmitInFlight?: () => boolean;
  /**
   * True while a stop press is still escalating (Ctrl-C, settle, re-check,
   * maybe Ctrl-C again — see `claudeCliInterrupt`). The first Ctrl-C ends the
   * turn well inside the escalation's 1500ms settle, so the idle edge fires and
   * a flush here starts a NEW turn that the escalation's re-check cannot tell
   * from the old one refusing to die — its second Ctrl-C then kills the queued
   * prompt and the TUI drops the text back into the prompt box. Hold the flush
   * until the escalation is over.
   */
  isInterruptInFlight?: () => boolean;
  /**
   * True when this app run typed the row into the CLI and is watching for the
   * CLI to take it. A marked row nobody is watching was left by an earlier run;
   * that CLI and its queue are gone. `settleTerminalRow` checks that CLI's log:
   * a row it already took is completed (never sent twice), any other row is
   * released and sent normally.
   */
  isTerminalRowTracked?: (promptId: string) => boolean;
  settleTerminalRow?: (promptId: string) => Promise<'consumed' | 'released'>;
}

/**
 * Claim + submit the oldest pending queued prompt for the session. Returns true
 * iff a prompt was claimed and written to the PTY. Marks the prompt completed on
 * success, failed on error or on a submission that delivered nothing (so it
 * doesn't get stuck in `executing`, and doesn't disappear as if it had run).
 */
export async function flushNextClaudeCliQueuedPrompt(
  args: { sessionId: string; workspacePath: string },
  deps: FlushClaudeCliQueueDeps,
): Promise<boolean> {
  // Check before claiming: a claimed prompt we then decline to send would have to
  // be rolled back out of `executing`.
  if (deps.isSubmitInFlight?.()) return false;
  if (deps.isInterruptInFlight?.()) return false;

  const pending = await deps.listPending(args.sessionId);
  if (pending.length === 0) return false;
  // A row typed into the busy CLI sits in the CLI's own queue, and the CLI runs
  // it itself. Wait for it to be consumed (`claudeCliTerminalQueue`) rather
  // than typing anything else in ahead of it or sending it twice.
  const sendable: FlushQueuedPrompt[] = [];
  for (const row of pending) {
    if (!readCliTerminalQueueMarker(row.documentContext)) {
      sendable.push(row);
      continue;
    }
    if (!deps.isTerminalRowTracked || deps.isTerminalRowTracked(row.id)) return false;
    const outcome = deps.settleTerminalRow ? await deps.settleTerminalRow(row.id) : 'released';
    if (outcome === 'consumed') continue;
    row.documentContext = { ...(row.documentContext as object), cliTerminalQueue: undefined } as ClaudeCliDocumentContext;
    sendable.push(row);
  }
  if (sendable.length === 0) return false;

  const claimed = await deps.claim(sendable[0].id);
  if (!claimed) return false;

  deps.notifyClaimed?.(claimed.id);

  try {
    const { submitted } = await deps.submit({
      sessionId: args.sessionId,
      workspacePath: args.workspacePath,
      prompt: claimed.prompt ?? '',
      attachments: (claimed.attachments as ChatAttachment[] | undefined) ?? undefined,
      documentContext: claimed.documentContext ?? undefined,
    });
    // #1387: `submitted: false` means the prompt never reached the PTY (nothing
    // to compose). Completing it anyway dropped it from the queue silently, with
    // no record and nothing shown to the user.
    if (!submitted) {
      await deps.fail(claimed.id, 'Prompt was not delivered to the Claude CLI (nothing to send).');
      return false;
    }
    await deps.complete(claimed.id);
    return true;
  } catch (error) {
    await deps.fail(claimed.id, error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}
