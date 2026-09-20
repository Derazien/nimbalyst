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
  /**
   * Answer many paths in one round trip, in the order asked. Optional: a host without it is
   * asked path by path. A host that lists files by the thousand should provide it.
   */
  resolveMany?: (filePaths: string[]) => Promise<Array<FileOrigin | null>>;
  /** Open the file in the window that shows `project`. Absent when the host cannot. */
  openInProject?: (filePath: string, project: string) => Promise<unknown>;
}

export const fileOriginResolverAtom = atom<FileOriginResolver | null>(null);

/** Answers so far, `null` recording a miss so a path is not asked about twice. */
export const resolvedFileOriginsAtom = atom<Map<string, FileOrigin | null>>(new Map<string, FileOrigin | null>());

/**
 * Bookkeeping for lookups, one per store and deliberately NOT reactive state: nothing renders
 * from it, and it is touched once per badge.
 *
 * It used to be a Set in an atom, copied on every lookup, next to an answers map copied on
 * every answer, each answer waking every mounted badge. That is quadratic in the number of
 * badges, and a file list is not bounded: a project with 66,909 untracked files in a
 * `.pnpm-store` mounted that many badges in one commit and froze the window for minutes.
 * Mutated in place here; the only reactive write is one answers map per batch.
 */
interface FileOriginLookupState {
  inFlight: Set<string>;
  queued: string[];
  flushScheduled: boolean;
  /** Bumped when the answers are cleared, so a batch asked for the previous project is dropped. */
  generation: number;
}

const fileOriginLookupStateAtom = atom<FileOriginLookupState>(() => ({
  inFlight: new Set<string>(),
  queued: [],
  flushScheduled: false,
  generation: 0,
}));

export const fileOriginByPathAtom = atomFamily((filePath: string) =>
  atom((get) => get(resolvedFileOriginsAtom).get(filePath) ?? null),
);

async function askHost(resolver: FileOriginResolver, filePaths: string[]): Promise<Array<FileOrigin | null>> {
  if (resolver.resolveMany) {
    try {
      return await resolver.resolveMany(filePaths);
    } catch {
      return filePaths.map(() => null);
    }
  }
  return Promise.all(filePaths.map((filePath) => resolver.resolve(filePath).catch(() => null)));
}

/**
 * Ask the host about a path, once. Safe to call on every render.
 *
 * Paths asked in the same tick (every badge of a commit mounts in one) go to the host as one
 * batch and come back as one write to the answers map.
 */
export const lookupFileOriginAtom = atom(null, async (get, set, filePath: string) => {
  if (!filePath) return;
  if (get(resolvedFileOriginsAtom).has(filePath)) return;
  const state = get(fileOriginLookupStateAtom);
  if (state.inFlight.has(filePath)) return;
  if (!get(fileOriginResolverAtom)) return;

  state.inFlight.add(filePath);
  state.queued.push(filePath);
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  await Promise.resolve();

  const batch = state.queued;
  const generation = state.generation;
  const inFlight = state.inFlight;
  state.queued = [];
  state.flushScheduled = false;
  const resolver = get(fileOriginResolverAtom);
  const answers = resolver ? await askHost(resolver, batch) : batch.map(() => null);

  // The window switched project while the host was answering: "foreign" meant the previous
  // project. Drop the batch. Its in-flight set was discarded with it, so the badges of the
  // new project were never held back from asking again.
  if (generation !== state.generation) return;
  for (const asked of batch) inFlight.delete(asked);
  const resolved = new Map(get(resolvedFileOriginsAtom));
  batch.forEach((asked, index) => resolved.set(asked, answers[index] ?? null));
  set(resolvedFileOriginsAtom, resolved);
});

/**
 * Forget every answer. The host calls this when the window switches project, since "foreign"
 * is relative to the project on screen.
 */
export const clearFileOriginsAtom = atom(null, (get, set) => {
  const state = get(fileOriginLookupStateAtom);
  state.generation += 1;
  state.inFlight = new Set();
  set(resolvedFileOriginsAtom, new Map());
});
