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
import { getAlphaFeatures } from '../utils/store';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';

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
  // no settings or window-registry cost. Another spelling of the caller's
  // project (case, symlink, separators) is the same workspace (#1551).
  if (sameWorkspaceIdentity(target.workspacePath, callerWorkspaceId)) {
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

/* ------------------------------------------------------------------ spawning into a project */

/**
 * Spawning a NEW session into another project.
 *
 * This is a different act from reaching a session that already exists there, and it cannot
 * reuse `isCrossWorkspaceAccessAllowed`: there is no target session, so `created_by` has
 * nothing to compare against. Three facts decide it:
 *
 *   1. the `cross-project` experimental toggle is on (this whole surface is opt-in)
 *   2. `agent.crossWorkspaceMessaging` is not `off` (the estate-wide master switch)
 *   3. the target project is open in a live window
 *
 * `creator` is enough for (2). A caller that spawns a session elsewhere is by definition its
 * creator, so under `creator` it can reach the session it just made; the two compose rather
 * than leaving a session it may not talk to.
 *
 * (3) exists because a session in a project with no window has nothing to show it and no
 * services warmed for it. Refusing is honest; spawning into the void is not.
 */
export interface CrossProjectSpawnInput {
  /** The `cross-project` alpha feature toggle. */
  featureEnabled: boolean;
  mode: CrossWorkspaceMessagingMode;
  callerWorkspaceId: string;
  /** Where the caller wants the new session to live. */
  targetWorkspacePath: string;
  isWorkspaceLoaded: (workspacePath: string) => boolean;
}

export function isCrossProjectSpawnAllowed(input: CrossProjectSpawnInput): boolean {
  const { featureEnabled, mode, callerWorkspaceId, targetWorkspacePath, isWorkspaceLoaded } = input;
  if (!targetWorkspacePath) return false;
  if (targetWorkspacePath === callerWorkspaceId) return true;
  if (!featureEnabled) return false;
  if (mode === 'off') return false;
  return isWorkspaceLoaded(targetWorkspacePath);
}

export interface CrossProjectSpawnDecision {
  allowed: boolean;
  mode: CrossWorkspaceMessagingMode;
  featureEnabled: boolean;
}

/** Is the `cross-project` toggle on? Fails closed if the store cannot be read. */
export function readCrossProjectFeatureEnabled(): boolean {
  try {
    return getAlphaFeatures()['cross-project'] === true;
  } catch (err) {
    console.warn('[crossWorkspaceMessaging] could not read the cross-project toggle, treating as off:', err);
    return false;
  }
}

/** Runtime check used by MetaAgentService, binding the predicate to the stores. */
export function resolveCrossProjectSpawn(
  callerWorkspaceId: string,
  targetWorkspacePath: string,
): CrossProjectSpawnDecision {
  // The caller's own project is the overwhelmingly common case and must not pay for two
  // store reads, nor be gated by an experimental toggle it has nothing to do with. That
  // includes another spelling of it (#1551).
  if (sameWorkspaceIdentity(targetWorkspacePath, callerWorkspaceId)) {
    return { allowed: true, mode: 'off', featureEnabled: false };
  }
  const featureEnabled = readCrossProjectFeatureEnabled();
  const mode = readCrossWorkspaceMessagingMode();
  const allowed = isCrossProjectSpawnAllowed({
    featureEnabled,
    mode,
    callerWorkspaceId,
    targetWorkspacePath,
    isWorkspaceLoaded: hasLiveWindowForWorkspace,
  });
  return { allowed, mode, featureEnabled };
}

/**
 * Name the ONE switch that is in the way. A refusal that lists every precondition makes the
 * caller guess; this says which thing to change and stops.
 */
export function crossProjectSpawnRefusal(
  targetWorkspacePath: string,
  decision: CrossProjectSpawnDecision,
): string {
  if (!decision.featureEnabled) {
    return `Cannot spawn into ${targetWorkspacePath}: turn on the Cross-project sessions experimental feature (Settings > Advanced > Alpha Features).`;
  }
  if (decision.mode === 'off') {
    return `Cannot spawn into ${targetWorkspacePath} (crossWorkspaceMessaging=off): set Cross-workspace messaging to "sessions it created" or wider.`;
  }
  return `Cannot spawn into ${targetWorkspacePath}: that project is not open in a window.`;
}
