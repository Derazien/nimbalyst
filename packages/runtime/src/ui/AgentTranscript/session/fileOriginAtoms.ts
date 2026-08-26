/**
 * Where a file named in a transcript comes from.
 *
 * An agent's session names files it touched, and some are in another project or in a
 * directory nobody registered. The file still opens in this window, as it always did; the
 * badge next to it says where it came from and, for a known project, takes you there.
 *
 * The runtime cannot know which projects exist, so the host installs a resolver
 * (`fileOriginResolverAtom`). `FileOriginBadge` asks it once per path and keeps the answer,
 * including "nothing", so a transcript with the same file named fifty times asks once.
 * Mirrors `sessionRefAtoms` for sessions.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';

export interface FileOrigin {
  /** The owning project's path, or null for a directory nobody registered. */
  project: string | null;
  name: string | null;
  /** The project rail's two-letter label and accent color, when there is a project. */
  initials: string | null;
  color: string | null;
  /** True when the file is not inside the project the window is showing. */
  foreign: boolean;
}

/**
 * Host-installed lookup and jump. Wrapped in an object on purpose: jotai treats a bare
 * function passed to `store.set` as an updater.
 */
export interface FileOriginResolver {
  resolve: (filePath: string) => Promise<FileOrigin | null>;
  /** Open the file in the window that shows `project`. Absent when the host cannot. */
  openInProject?: (filePath: string, project: string) => Promise<unknown>;
}

export const fileOriginResolverAtom = atom<FileOriginResolver | null>(null);

/** Answers so far, `null` recording a miss so a path is not asked about twice. */
export const resolvedFileOriginsAtom = atom<Map<string, FileOrigin | null>>(new Map());

const fileOriginInFlightAtom = atom<Set<string>>(new Set());

export const fileOriginByPathAtom = atomFamily((filePath: string) =>
  atom((get) => get(resolvedFileOriginsAtom).get(filePath) ?? null),
);

/** Ask the host about a path, once. Safe to call on every render. */
export const lookupFileOriginAtom = atom(null, async (get, set, filePath: string) => {
  if (!filePath) return;
  if (get(resolvedFileOriginsAtom).has(filePath)) return;
  const inFlight = get(fileOriginInFlightAtom);
  if (inFlight.has(filePath)) return;
  const resolver = get(fileOriginResolverAtom);
  if (!resolver) return;

  set(fileOriginInFlightAtom, new Set(inFlight).add(filePath));
  let result: FileOrigin | null = null;
  try {
    result = await resolver.resolve(filePath);
  } catch {
    result = null;
  }
  const resolved = new Map(get(resolvedFileOriginsAtom));
  resolved.set(filePath, result);
  set(resolvedFileOriginsAtom, resolved);
  const stillInFlight = new Set(get(fileOriginInFlightAtom));
  stillInFlight.delete(filePath);
  set(fileOriginInFlightAtom, stillInFlight);
});

/**
 * Forget every answer. The host calls this when the window switches project, since "foreign"
 * is relative to the project on screen.
 */
export const clearFileOriginsAtom = atom(null, (_get, set) => {
  set(resolvedFileOriginsAtom, new Map());
});
