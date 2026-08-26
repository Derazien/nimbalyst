/**
 * Which project owns a session or a file.
 *
 * A session lives in exactly one project: the workspace on its row. A file lives in whichever
 * known project is the longest prefix of its path, or in none. Both answers drive the same
 * "other project" badge on transcript chips, so they share one notion of "foreign": not the
 * project the window is currently showing.
 *
 * Pure. Main binds it to the window registry and the recent-projects list; the renderer
 * never compares paths itself, because path spelling on Windows (case, separators, drive
 * letters) is exactly the kind of thing that goes wrong when every caller does it by hand.
 */

import { normalizePath } from './pathUtils';

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** One spelling for comparison. Windows drive paths compare case-insensitively. */
function comparable(p: string): string {
  const n = normalizePath(p);
  return WINDOWS_DRIVE.test(p) ? n.toLowerCase() : n;
}

export function pathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return comparable(a) === comparable(b);
}

/** Is `filePath` inside `dir` (or `dir` itself)? Boundary-safe: `/a/b_x` is not inside `/a/b`. */
function isInside(filePath: string, dir: string): boolean {
  const f = comparable(filePath);
  const d = comparable(dir);
  return f === d || f.startsWith(d + '/');
}

export interface SessionProjectLocation {
  /** The session's own workspace, as stored. Null when the row has none. */
  project: string | null;
  /** True when that is not the project the window is showing. */
  foreign: boolean;
}

export function locateSessionProject(
  sessionWorkspace: string | null | undefined,
  activeWorkspace: string | null | undefined,
): SessionProjectLocation {
  if (!sessionWorkspace) return { project: null, foreign: false };
  return { project: sessionWorkspace, foreign: !pathsEqual(sessionWorkspace, activeWorkspace) };
}

export interface KnownProject {
  path: string;
  name: string;
  /** Open in some window right now (primary or on a rail). */
  isOpen: boolean;
}

export interface PathProjectLocation {
  /** The owning project's path, or null for a directory nobody registered. */
  project: string | null;
  name: string | null;
  isOpen: boolean;
  /**
   * True when the file is not inside the project the window is showing. A loose directory
   * is foreign too: it is not here, and the badge should say so even if it cannot say where.
   */
  foreign: boolean;
}

/**
 * Longest-prefix match, so a file under `C:/work/artificial.inc` belongs to artificial.inc and
 * not to `C:/work`, which also contains it. The active project wins ties by being the answer
 * to "is it here": a file inside the active project is never foreign, whatever else matches.
 */
export function locatePathAmongProjects(
  filePath: string,
  projects: readonly KnownProject[],
  activeWorkspace: string | null | undefined,
): PathProjectLocation {
  let best: KnownProject | null = null;
  for (const candidate of projects) {
    if (!candidate.path || !isInside(filePath, candidate.path)) continue;
    if (!best || comparable(candidate.path).length > comparable(best.path).length) best = candidate;
  }
  if (!best) return { project: null, name: null, isOpen: false, foreign: true };
  const insideActive = !!activeWorkspace && isInside(filePath, activeWorkspace);
  // A file inside the active project counts as home even when a nested project also claims
  // it, unless that nested project is the better match: then it is that project's file.
  const foreign = insideActive
    ? !pathsEqual(best.path, activeWorkspace) && comparable(best.path).length > comparable(activeWorkspace).length
    : true;
  return { project: best.path, name: best.name, isOpen: best.isOpen, foreign };
}
