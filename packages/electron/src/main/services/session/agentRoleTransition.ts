/**
 * Pure validation for AI session agent-role transitions.
 *
 * `agentRole` is otherwise write-once: it is set at session creation
 * (`CreateSessionPayload.agentRole`) and never revisited. This module backs
 * the one IPC route that reclassifies a session after the fact -- for
 * example moving a companion head from 'meta-agent' to 'companion', or
 * bringing a session that predates the companion taxonomy entirely (it has
 * sat at 'standard' since before 'sub-companion' existed, e.g. the Looc QA
 * resident) into the companion family for the first time.
 *
 * Transitions are validated only against the known `AgentRole` union, not
 * against the current role. A stateless, single-call validator cannot tell
 * "an operator is classifying a pre-taxonomy session" apart from "something
 * is undoing a completed promotion" -- both look like the same
 * (currentRole, requestedRole) pair -- so it should not pretend to. The
 * one-way promotion ratchet (a session promoted OUT of the companion family
 * to 'standard' should not slide back in) belongs in the promotion flow
 * itself, the only place that actually knows a promotion is what is
 * happening. `currentRole` stays in the signature, unused by today's single
 * check, so a caller with that contextual knowledge has somewhere to plug a
 * real transition rule in later without changing every call site.
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
 * Validate a proposed agent-role transition. Rejects anything outside the
 * `AgentRole` union -- the check that actually earns its place here, since
 * it stands between a typo and a session that vanishes from every list (the
 * visibility predicate in `renderer/store/atoms/sessions.ts` hides sessions
 * by role). Otherwise accepts any transition in either direction, including
 * 'standard' to a companion-family role.
 */
export function validateAgentRoleTransition(
  currentRole: AgentRole,
  requestedRole: string,
): AgentRoleTransitionResult {
  if (!AGENT_ROLES.has(requestedRole)) {
    return { ok: false, error: `Unknown agent role: ${requestedRole}` };
  }
  return { ok: true, role: requestedRole as AgentRole };
}
