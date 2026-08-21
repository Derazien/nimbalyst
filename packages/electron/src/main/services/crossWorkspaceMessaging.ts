/**
 * Cross-workspace session access for the host MCP tools.
 *
 * Historically every session-targeting tool (send_prompt, notify_user,
 * respond_to_prompt, get_session_status/result, list_queued_prompts) required
 * the target to live in the caller's own workspace. The
 * `agent.crossWorkspaceMessaging` setting widens that on purpose:
 *
 *   off     -- same workspace only (default)
 *   creator -- also sessions the calling session created (spawn_session /
 *              create_session record created_by_session_id)
 *   allow   -- also any session whose workspace is open in a live window,
 *              plus (as a superset of creator) the caller's own children
 *
 * Possession of a session id never grants access on its own, and execution
 * always stays in the target session's own cwd (worktree or workspace).
 *
 * The predicate is pure so it can be unit tested; the two thin readers at the
 * bottom bind it to SettingsService and the window registry.
 */

import { getSettingsService } from './SettingsService';
import { hasLiveWindowForWorkspace } from '../window/windowState';

export type CrossWorkspaceMessagingMode = 'off' | 'creator' | 'allow';

export interface CrossWorkspaceTarget {
  workspacePath?: string | null;
  createdBySessionId?: string | null;
}

export interface CrossWorkspaceAccessInput {
  mode: CrossWorkspaceMessagingMode;
  /** The session issuing the tool call (may be empty for legacy callers). */
  callerSessionId: string | null | undefined;
  /** The caller's canonical workspace path. */
  callerWorkspaceId: string;
  target: CrossWorkspaceTarget;
  /** Whether a workspace path is currently open in a live window. */
  isWorkspaceLoaded: (workspacePath: string) => boolean;
}

/**
 * Whether the caller may act on `target`. Same-workspace targets are always
 * allowed; everything else depends on the mode.
 */
export function isCrossWorkspaceAccessAllowed(input: CrossWorkspaceAccessInput): boolean {
  const { mode, callerSessionId, callerWorkspaceId, target, isWorkspaceLoaded } = input;
  const targetWorkspace = target.workspacePath;
  if (!targetWorkspace) return false;
  if (targetWorkspace === callerWorkspaceId) return true;

  const createdByCaller =
    !!callerSessionId && !!target.createdBySessionId && target.createdBySessionId === callerSessionId;

  switch (mode) {
    case 'creator':
      return createdByCaller;
    case 'allow':
      return createdByCaller || isWorkspaceLoaded(targetWorkspace);
    default:
      return false;
  }
}

/**
 * One message for "does not exist" and "exists but not reachable", so a caller
 * learns why it was refused without the tool becoming an oracle for which
 * session ids exist in other workspaces.
 */
export function sessionNotReachableMessage(sessionId: string, mode: CrossWorkspaceMessagingMode): string {
  return `Session ${sessionId} not found or not allowed across workspaces (crossWorkspaceMessaging=${mode})`;
}

/** Current mode from settings; fails closed if the store cannot be read. */
export function readCrossWorkspaceMessagingMode(): CrossWorkspaceMessagingMode {
  try {
    return getSettingsService().get('agent.crossWorkspaceMessaging');
  } catch (err) {
    console.warn('[crossWorkspaceMessaging] could not read setting, treating as off:', err);
    return 'off';
  }
}

/**
 * Runtime check used by MetaAgentService: resolves the mode and the window
 * registry, then applies the pure predicate. A null `target` (session not
 * found) is refused with the same message as a disallowed one.
 */
export function resolveCrossWorkspaceAccess(
  callerSessionId: string | null | undefined,
  callerWorkspaceId: string,
  target: CrossWorkspaceTarget | null | undefined,
): { allowed: boolean; mode: CrossWorkspaceMessagingMode } {
  if (!target) return { allowed: false, mode: 'off' };
  // Same-workspace access never consults the setting, so the common path has
  // no settings or window-registry cost.
  if (target.workspacePath && target.workspacePath === callerWorkspaceId) {
    return { allowed: true, mode: 'off' };
  }
  const mode = readCrossWorkspaceMessagingMode();
  const allowed = isCrossWorkspaceAccessAllowed({
    mode,
    callerSessionId,
    callerWorkspaceId,
    target,
    isWorkspaceLoaded: hasLiveWindowForWorkspace,
  });
  return { allowed, mode };
}
