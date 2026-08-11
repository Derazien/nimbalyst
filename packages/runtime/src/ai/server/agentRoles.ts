/**
 * Agent role vocabulary and predicates.
 *
 * Pure: no React, no Jotai, no IO. Every consumer that needs to ask "is this a
 * companion session" imports from here rather than comparing string literals,
 * so adding a role later is one edit rather than a grep.
 */
import type { AgentRole } from './types';

export const COMPANION_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'companion',
  'sub-companion',
]);

/** True for the companion head and for her surface-bound assistants. */
export function isCompanionRole(role: AgentRole | undefined | null): boolean {
  return role != null && COMPANION_ROLES.has(role);
}

/** True only for the companion head. There is exactly one per workspace. */
export function isCompanionHead(role: AgentRole | undefined | null): boolean {
  return role === 'companion';
}

/** True only for a surface-bound assistant owned by the companion. */
export function isSubCompanion(role: AgentRole | undefined | null): boolean {
  return role === 'sub-companion';
}
