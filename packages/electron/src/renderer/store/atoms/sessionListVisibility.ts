/**
 * Root session list visibility.
 *
 * Extracted from the inline filter in sessions.ts (sessionListRootAtom) when
 * companion roles were added. The rule set is small but it is the single most
 * behaviour-critical predicate in the list, and it deserves its own tests.
 *
 * Pure: no Jotai, no IO.
 */
import type { SessionMeta } from '@nimbalyst/runtime';
import { isCompanionRole } from '@nimbalyst/runtime/ai/server/agentRoles';

export interface RootListVisibilityOptions {
  showArchived: boolean;
  showCompanion: boolean;
}

/**
 * Decide whether a session belongs in the root session list.
 *
 * Order matters. Archive is checked first because an archived companion
 * session must stay hidden when only the companion toggle is on, which is the
 * case that produces a confusing list otherwise: reaped review sessions would
 * flood the group the moment it was opened.
 */
export function shouldShowInRootList(
  session: SessionMeta,
  registry: ReadonlyMap<string, SessionMeta>,
  opts: RootListVisibilityOptions,
): boolean {
  if (!opts.showArchived && session.isArchived) return false;

  // Companion sessions are hidden by default: Lea's home is the FAB, and her
  // assistants live in the surfaces they serve. Work she SPAWNED stays
  // 'standard' and is unaffected by this branch.
  if (isCompanionRole(session.agentRole)) return opts.showCompanion;

  // Root sessions (no parent) are always included.
  if (!session.parentSessionId) return true;

  // Blitz children are included so they reach worktreeGroupsData and can be
  // grouped into BlitzGroup by parentSessionId.
  const parent = registry.get(session.parentSessionId);
  return parent?.sessionType === 'blitz';
}
