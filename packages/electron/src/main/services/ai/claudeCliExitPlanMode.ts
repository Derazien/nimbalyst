/**
 * Plan approval for the genuine `claude-code-cli` lane, answered from Nimbalyst's ExitPlanMode
 * card instead of the CLI's terminal dialog.
 *
 * A PreToolUse hook on ExitPlanMode (resources/claudeCliPermissionHook.cjs, `exit-plan-mode`
 * mode) POSTs to the loopback `/exit-plan-mode` endpoint and blocks. That request parks here as
 * the session's one pending plan approval; the card's answer arrives over the
 * `claude-cli:exit-plan-mode-response` IPC and resolves it. The hook turns the answer into
 * allow/deny output. Anything else (timeout, abort, a newer request) resolves `ask`, and the
 * hook then prints nothing so the CLI shows its own dialog.
 *
 * Electron-free so the registry is unit-testable. The tool_use itself reaches the transcript
 * through the SSE proxy and its tool_result arrives from the CLI's next request, so unlike the
 * ToolPermission flow nothing synthetic is persisted here.
 */

import type { PlanDriveResult } from './claudeCliPlanDialog';

export type ExitPlanUserAnswer =
  | { decision: 'approve' }
  | { decision: 'deny'; feedback?: string };

/**
 * What the card can send. `approve-manual` = approve but keep being asked before each edit: on the
 * screen path it picks the dialog's option 2; on the hook path it is the same allow as `approve`
 * (an ask project is already in the manual mode), so the hook script never sees it.
 */
export type ExitPlanCardAnswer = ExitPlanUserAnswer | { decision: 'approve-manual' };

/** What the endpoint tells the hook. `ask` = print nothing, let the CLI's dialog show. */
export type ExitPlanHookAnswer = ExitPlanUserAnswer | { decision: 'ask' };

/** The card can sit unread for a while; stay under the hook's 3600 s timeout. */
export const EXIT_PLAN_MAX_WAIT_MS = 55 * 60 * 1000;

interface PendingExitPlan {
  settle: (answer: ExitPlanHookAnswer) => void;
}

/**
 * How the card can answer this session's plan approval:
 * - `hook`: ask projects. A PreToolUse hook on ExitPlanMode is parked here and answered directly.
 * - `screen`: skip-permissions projects. The CLI shows its own dialog and Nimbalyst types the
 *   answer into it, because only the dialog's option 1 can switch the CLI to bypass.
 * - `none`: no way to answer (MCP lockdown, no hook script); the terminal dialog is the only way.
 */
export type ExitPlanAnswerPath = 'hook' | 'screen' | 'none';

const pending = new Map<string, PendingExitPlan>();
const answerPaths = new Map<string, ExitPlanAnswerPath>();

/** Launcher records which way this session's CLI process can be answered. */
export function setExitPlanAnswerPath(sessionId: string, path: ExitPlanAnswerPath): void {
  answerPaths.set(sessionId, path);
}

export function getExitPlanAnswerPath(sessionId: string): ExitPlanAnswerPath {
  return answerPaths.get(sessionId) ?? 'none';
}

/** Renderer capability: true when the card can answer for this session by either path. */
export function isExitPlanCardInteractive(sessionId: string): boolean {
  return getExitPlanAnswerPath(sessionId) !== 'none';
}

export function hasPendingExitPlan(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** Validate a renderer payload; null when it cannot be acted on. */
export function parseExitPlanResponse(payload: unknown): { sessionId: string; answer: ExitPlanCardAnswer } | null {
  const p = payload as { sessionId?: unknown; decision?: unknown; feedback?: unknown } | null | undefined;
  if (!p || typeof p.sessionId !== 'string' || !p.sessionId) return null;
  if (p.decision === 'approve') return { sessionId: p.sessionId, answer: { decision: 'approve' } };
  if (p.decision === 'approve-manual') return { sessionId: p.sessionId, answer: { decision: 'approve-manual' } };
  if (p.decision === 'deny') {
    const feedback = typeof p.feedback === 'string' && p.feedback.trim() ? p.feedback.trim() : undefined;
    return { sessionId: p.sessionId, answer: { decision: 'deny', ...(feedback ? { feedback } : {}) } };
  }
  return null;
}

export interface WaitForExitPlanOptions {
  signal?: AbortSignal;
  maxWaitMs?: number;
}

/**
 * Park the session's plan approval. A session has at most one: a newer request replaces the
 * older one, which resolves `ask` (its hook process is gone or about to be).
 */
export function waitForExitPlanAnswer(
  sessionId: string,
  options: WaitForExitPlanOptions = {},
): Promise<ExitPlanHookAnswer> {
  pending.get(sessionId)?.settle({ decision: 'ask' });

  return new Promise<ExitPlanHookAnswer>((resolve) => {
    let done = false;
    const entry: PendingExitPlan = {
      settle: (answer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (pending.get(sessionId) === entry) pending.delete(sessionId);
        resolve(answer);
      },
    };
    const onAbort = () => entry.settle({ decision: 'ask' });
    const timer = setTimeout(() => entry.settle({ decision: 'ask' }), options.maxWaitMs ?? EXIT_PLAN_MAX_WAIT_MS);

    pending.set(sessionId, entry);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Deliver the card's answer. False when nothing is waiting (hook gone, already answered). */
export function resolveExitPlanAnswer(sessionId: string, answer: ExitPlanUserAnswer): boolean {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  entry.settle(answer);
  return true;
}

export interface ExitPlanHookRequest {
  sessionId: string;
  toolInput?: unknown;
  permissionMode?: string;
}

export interface ExitPlanHookDeps {
  /** True for a `claude-code-cli` session; anything else is answered `ask`. */
  isCliSession: (sessionId: string) => Promise<boolean>;
  /** Show the session as waiting on the user and fire the blocked notification. */
  markBlocked: (request: ExitPlanHookRequest) => void;
  /** Undo `markBlocked` once the request settles. */
  markSettled: (request: ExitPlanHookRequest) => void;
  log?: (message: string) => void;
}

/**
 * One hook request end to end. Never throws: the endpoint maps any failure to `ask` itself, but
 * a session that is not a CLI session or has no hook installed must not park a request.
 */
export async function handleExitPlanHookRequest(
  request: ExitPlanHookRequest,
  deps: ExitPlanHookDeps,
  options: WaitForExitPlanOptions = {},
): Promise<ExitPlanHookAnswer> {
  if (!request.sessionId || !(await deps.isCliSession(request.sessionId))) {
    return { decision: 'ask' };
  }
  deps.markBlocked(request);
  try {
    const answer = await waitForExitPlanAnswer(request.sessionId, options);
    deps.log?.(`[ExitPlanMode] ${request.sessionId} settled: ${answer.decision}`);
    return answer;
  } finally {
    // A superseded request settles after its replacement is parked; that one still owns the flag.
    if (!hasPendingExitPlan(request.sessionId)) deps.markSettled(request);
  }
}

export interface ExitPlanCardDeps {
  /** Types the answer into the CLI's own dialog (skip-permissions projects). */
  driveScreen: (sessionId: string, answer: ExitPlanCardAnswer) => Promise<PlanDriveResult>;
}

export type ExitPlanCardResult =
  | { success: true; via: 'hook' | 'screen'; mode?: string | null; bypassConfirmed?: boolean }
  | { success: false; error: string };

/**
 * The card's answer, routed by how the session can be answered. A skip project never has a parked
 * hook, so it goes to the screen; an ask project never types into the terminal. A screen answer
 * that cannot be verified leaves the dialog untouched and tells the card to defer to the terminal.
 */
export async function answerExitPlanFromCard(
  sessionId: string,
  answer: ExitPlanCardAnswer,
  deps: ExitPlanCardDeps,
): Promise<ExitPlanCardResult> {
  const path = getExitPlanAnswerPath(sessionId);
  if (path === 'hook') {
    // An ask project's allow already lands in the manual mode, so "ask before each edit" is plain approve.
    const hookAnswer: ExitPlanUserAnswer = answer.decision === 'approve-manual' ? { decision: 'approve' } : answer;
    return resolveExitPlanAnswer(sessionId, hookAnswer)
      ? { success: true, via: 'hook' }
      : { success: false, error: 'No plan approval is waiting. Answer in the terminal.' };
  }
  if (path === 'screen') {
    const result = await deps.driveScreen(sessionId, answer);
    // `confirmed` = the footer read the mode this answer asked for (bypass, or default for manual).
    return result.ok
      ? { success: true, via: 'screen', mode: result.mode, bypassConfirmed: result.confirmed }
      : { success: false, error: `Answer in the terminal: ${result.reason}.` };
  }
  return { success: false, error: 'This session cannot be answered from here. Answer in the terminal.' };
}

/** Test seam: forget all sessions. */
export function resetExitPlanModeStateForTests(): void {
  for (const entry of [...pending.values()]) entry.settle({ decision: 'ask' });
  pending.clear();
  answerPaths.clear();
}
