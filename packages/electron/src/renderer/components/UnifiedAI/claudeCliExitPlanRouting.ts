import { isClaudeCliTerminalSession, CLAUDE_CLI_PROVIDER_ID } from './claudeCliInputRouting';

/**
 * Where an ExitPlanMode card's answer goes, per session type.
 *
 * - `claude-code` (Agent SDK): the existing `ai:exitPlanModeConfirmResponse` flow.
 * - `claude-code-cli` that main can answer: the card calls `claude-cli:exit-plan-mode-response`.
 *   Ask projects resolve a parked PreToolUse hook; skip-permissions projects have main type into
 *   the CLI's own dialog (bypass, or manual edit approval). Only approve / keep-planning make sense either way
 *   (the CLI cannot start a new session or be stopped from the card).
 * - Any other terminal CLI, or a `claude-code-cli` main cannot answer (an enterprise MCP
 *   lockdown): the CLI asks in its own dialog, so the card is read-only.
 */
export const CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL = 'claude-cli:exit-plan-mode-response';
export const CLAUDE_CLI_EXIT_PLAN_CAPABLE_CHANNEL = 'claude-cli:exit-plan-mode-capable';

export interface ExitPlanCardMode {
  /** Read-only card pointing at the terminal. */
  inTerminal: boolean;
  /** Interactive, but only approve / keep planning (no new session, no stop). */
  approveOrReviseOnly: boolean;
  /**
   * The card may offer "approve, ask before each edit" as its own choice. Only where it differs
   * from plain approve: the screen path, whose approve switches the CLI to bypass. An ask project's
   * approve already lands in the manual mode, so the extra button would be a duplicate.
   */
  canApproveManual: boolean;
}

/**
 * `hookInteractive` is the main process's answer for this session; null while it is unknown.
 * Unknown counts as interactive: the hook is installed on every launch that can have one, and a
 * click on a card nothing is waiting on fails safely (see `sendCliExitPlanResponse`).
 * `answerPath` is main's `hook` / `screen` / `none`, or null while unknown.
 */
export function resolveExitPlanCardMode(
  provider: string | null | undefined,
  hookInteractive: boolean | null,
  answerPath: string | null = null,
): ExitPlanCardMode {
  if (provider === CLAUDE_CLI_PROVIDER_ID) {
    const interactive = hookInteractive !== false;
    return {
      inTerminal: !interactive,
      approveOrReviseOnly: interactive,
      canApproveManual: interactive && answerPath === 'screen',
    };
  }
  return { inTerminal: isClaudeCliTerminalSession(provider), approveOrReviseOnly: false, canApproveManual: false };
}

/** True when the answer must go to the CLI hook rather than the SDK provider. */
export function routesExitPlanToCliHook(
  provider: string | null | undefined,
  hookInteractive: boolean | null,
): boolean {
  return provider === CLAUDE_CLI_PROVIDER_ID && hookInteractive !== false;
}

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * Deliver the card's answer to the parked hook. Throws when nothing was waiting (the hook
 * timed out or the CLI was interrupted) so the card reverts to pending and the user answers in
 * the terminal dialog instead.
 */
export async function sendCliExitPlanResponse(
  invoke: Invoke,
  sessionId: string,
  answer: { approved: true; manualEdits?: boolean } | { approved: false; feedback?: string },
): Promise<void> {
  const payload = answer.approved
    ? { sessionId, decision: answer.manualEdits ? ('approve-manual' as const) : ('approve' as const) }
    : { sessionId, decision: 'deny' as const, feedback: answer.feedback };
  const result = (await invoke(CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, payload)) as
    | { success?: boolean; error?: string }
    | undefined;
  if (!result?.success) {
    throw new Error(result?.error || 'Plan approval was not delivered');
  }
}
