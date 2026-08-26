/**
 * Live data + navigation seam for session reference chips.
 *
 * A transcript may reference another AI session by its id — inside a
 * cross-session tool call (`send_prompt`, `spawn_session`, …) or as a bare
 * UUID in prose. `SessionReferenceChip` resolves the session's live title +
 * phase from this cross-platform atom and opens it on click.
 *
 * The atom is populated by the platform host (the Electron renderer mirrors its
 * `sessionRegistryAtom` here; mobile can populate it later). Because the chip
 * reads the atom reactively, renaming a session or advancing its phase updates
 * every chip with no transcript edit. This mirrors the tracker-reference chip
 * architecture (`trackerReferenceData.ts`).
 *
 * Sessions in ANOTHER project are not in the host's registry, which only covers
 * the project the window is showing. For those the host installs a resolver
 * (`sessionRefResolverAtom`); the chip asks it once per unknown id and keeps the
 * answer, including "nothing", in `resolvedSessionRefsAtom`, which survives the
 * host replacing the registry mirror on every refresh.
 *
 * Navigation is dispatched via a window CustomEvent the host already listens
 * for (`open-ai-session`), so the chip depends only on runtime state, not on
 * renderer/IPC code.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';

/** Which project a session lives in, as the host wants it drawn. */
export interface SessionRefProject {
  /** Absolute project path. */
  path: string;
  /** Display name (usually the folder name). */
  name: string;
  /** The project rail's two-letter label. */
  initials: string;
  /** The project rail's accent color, any CSS color. */
  color: string;
  /** True when this is not the project the window is showing. */
  foreign: boolean;
}

/** The minimal live data a session chip needs to render. */
export interface SessionRefMeta {
  id: string;
  /** Human-readable session title. */
  title: string;
  /** Kanban phase (planning/implementing/validating/complete). */
  phase?: string;
  /** Provider id (claude-code, openai-codex, …) for an optional glyph. */
  provider?: string;
  /** True while the session is actively producing output. */
  isProcessing?: boolean;
  /** True when the session is blocked on an interactive prompt. */
  isAwaitingInput?: boolean;
  /** Where the session lives. Absent when the host does not track projects. */
  project?: SessionRefProject;
}

/**
 * All known sessions keyed by id. Host adapters populate this atom; session
 * chips read from it.
 */
export const sessionRefMapAtom = atom<Map<string, SessionRefMeta>>(new Map());

/**
 * Sorted, comma-joined known session ids. A string, so subscribers (every
 * transcript markdown block) are notified only when the set of ids changes,
 * not when a title or phase in the map does.
 */
export const sessionRefIdsKeyAtom = atom((get) =>
  Array.from(get(sessionRefMapAtom).keys()).sort().join(','),
);

/**
 * Answers the host resolver gave for ids the registry does not know. `null`
 * records a miss so a chip does not ask again for the same id.
 */
export const resolvedSessionRefsAtom = atom<Map<string, SessionRefMeta | null>>(new Map());

/** Ids a lookup is currently in flight for, so two chips for one id ask once. */
const sessionRefInFlightAtom = atom<Set<string>>(new Set());

/**
 * Host-installed lookup for a session id the registry does not know. Returns
 * the session's meta (with its project) or null when there is no such session,
 * or the host will not say. Absent on hosts without cross-project sessions.
 *
 * Wrapped in an object on purpose: jotai treats a bare function passed to
 * `store.set` as an updater and would call the resolver with the previous
 * value instead of storing it.
 */
export interface SessionRefResolver {
  resolve: (sessionId: string) => Promise<SessionRefMeta | null>;
}
export const sessionRefResolverAtom = atom<SessionRefResolver | null>(null);

/**
 * A single session's live meta by id, or null when unknown (not yet loaded /
 * different workspace). Registry data wins; a resolved foreign session is the
 * fallback. Reactive: only re-renders when that id changes.
 */
export const sessionRefByIdAtom = atomFamily((id: string) =>
  atom((get) => get(sessionRefMapAtom).get(id) ?? get(resolvedSessionRefsAtom).get(id) ?? null),
);

/**
 * Ask the host resolver about an id, once. Safe to call from every chip render:
 * a hit, a recorded miss, or an in-flight lookup all return immediately.
 */
export const lookupSessionRefAtom = atom(null, async (get, set, sessionId: string) => {
  if (!sessionId) return;
  if (get(sessionRefMapAtom).has(sessionId)) return;
  if (get(resolvedSessionRefsAtom).has(sessionId)) return;
  const inFlight = get(sessionRefInFlightAtom);
  if (inFlight.has(sessionId)) return;
  const resolver = get(sessionRefResolverAtom);
  if (!resolver) return;

  set(sessionRefInFlightAtom, new Set(inFlight).add(sessionId));
  let result: SessionRefMeta | null = null;
  try {
    result = await resolver.resolve(sessionId);
  } catch {
    result = null;
  }
  const resolved = new Map(get(resolvedSessionRefsAtom));
  resolved.set(sessionId, result);
  set(resolvedSessionRefsAtom, resolved);
  const stillInFlight = new Set(get(sessionRefInFlightAtom));
  stillInFlight.delete(sessionId);
  set(sessionRefInFlightAtom, stillInFlight);
});

/**
 * Ask the host to open a session by id. The Electron renderer listens for this
 * event in `App.tsx` (`handleOpenAiSession`). `workspacePath` is only needed to
 * seed a draft input, so opening an existing session works without it.
 */
export function openSessionReference(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('open-ai-session', { detail: { sessionId } }),
  );
}
