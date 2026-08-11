/**
 * Pure validation for AI session agent-role transitions.
 *
 * `agentRole` is otherwise write-once: it is set at session creation
 * (`CreateSessionPayload.agentRole`) and never revisited. This module backs
 * the one IPC route that reclassifies a session after the fact -- for
 * example moving a companion head from 'meta-agent' to 'companion' -- without
 * opening a path that lets an ordinary 'standard' session get promoted into
 * the companion family, where the visibility predicate in
 * `renderer/store/atoms/sessions.ts` hides sessions by role.
 *
 * The four legal role values are duplicated here as literals rather than
 * imported from `ai/server/agentRoles`: nothing in the main process may
 * import that module, because the production build's runtime dist does not
 * ship it (see electron.vite.config.ts's resolveWorkspaceSubpaths). This file
 * is intentionally free of any DB / IPC / Electron dependency so it can be
 * unit-tested in isolation.
 */

import type { AgentRole } from '@nimbalyst/runtime/ai/server/types';

const AGENT_ROLES: ReadonlySet<string> = new Set<AgentRole>([
  'standard',
  'meta-agent',
  'companion',
  'sub-companion',
]);

export type AgentRoleTransitionResult =
  | { ok: true; role: AgentRole }
  | { ok: false; error: string };

/**
 * Validate a proposed agent-role transition.
 *
 * Promotion out of 'standard' happens only at session creation, so a
 * 'standard' current role is rejected here regardless of the requested
 * target. Once a session already carries a non-standard role, it may move to
 * any other valid role, including back down to 'standard'.
 */
export function validateAgentRoleTransition(
  currentRole: AgentRole,
  requestedRole: string,
): AgentRoleTransitionResult {
  if (!AGENT_ROLES.has(requestedRole)) {
    return { ok: false, error: `Unknown agent role: ${requestedRole}` };
  }
  if (currentRole === 'standard') {
    return {
      ok: false,
      error: 'standard sessions cannot be promoted; agentRole is set at creation only',
    };
  }
  return { ok: true, role: requestedRole as AgentRole };
}
