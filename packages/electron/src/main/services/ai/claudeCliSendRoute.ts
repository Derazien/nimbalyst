/**
 * Route an `ai:sendMessage` prompt onto the genuine-CLI rails.
 *
 * `claude-code-cli` has no in-process turn driver: its provider `sendMessage`
 * is the Phase 1 stub that throws. NIM-834 already routes the queue dispatcher
 * around it, but every other caller of the send handler (the extension SDK
 * bridge, a meta-agent drive) still landed on the stub and stacked "not yet
 * implemented (Phase 1)" errors into the transcript while the real CLI turn ran
 * fine on its PTY. This is the shared decision those callers now go through.
 *
 * Pure core + injected deps so it unit-tests without a queue store or a PTY.
 */

export interface ClaudeCliSendRouteDeps {
  /** Persist a prompt on the session's queue. */
  enqueue(input: {
    id: string;
    sessionId: string;
    prompt: string;
    attachments?: unknown[];
  }): Promise<void>;
  /** Drive the session's queue, which lands on the CLI dispatch rails. */
  drive(sessionId: string, workspacePath: string, reason: string): Promise<boolean>;
  /** Id for a prompt this route puts on the queue itself. */
  newPromptId(): string;
}

export interface ClaudeCliSendRouteInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  /** Set when the queue dispatcher already claimed this prompt. */
  queuedPromptId?: string;
  /** Files sent with the prompt. Dropping them would lose them silently. */
  attachments?: unknown[];
}

/** Reason string carried into the queue drive, for log attribution. */
export const CLI_SEND_ROUTE_REASON = 'cli-send-route';

/**
 * Queue the prompt (unless the queue already holds it) and drive the session.
 * Returns whether the drive dispatched anything.
 */
export async function routePromptToClaudeCli(
  deps: ClaudeCliSendRouteDeps,
  input: ClaudeCliSendRouteInput,
): Promise<boolean> {
  if (!input.queuedPromptId) {
    // Enqueue first: a drive that runs against an empty queue delivers nothing.
    await deps.enqueue({
      id: deps.newPromptId(),
      sessionId: input.sessionId,
      prompt: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
  }

  return deps.drive(input.sessionId, input.workspacePath, CLI_SEND_ROUTE_REASON);
}
