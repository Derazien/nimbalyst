/**
 * Open a session by id from anywhere a session is named: a transcript chip, a tray entry, a
 * tracker menu.
 *
 * Every such opener used to mean "open this id in this window". Sessions load by id, so for a
 * session in another project that showed its transcript under the wrong project, absent from
 * the sidebar. The rule now: ask the host where the session lives; if it is not the project
 * this window is showing, hand it to the host's cross-project router, which switches the rail
 * or raises the right window. Only then, or when the host cannot say, open it here.
 *
 * The host calls are injected so the decision is provable without a window.
 */

export interface SessionLocation {
  workspacePath: string | null;
  /** True when the session's project is not the one this window is showing. */
  foreign: boolean;
  title?: string | null;
}

export interface OpenSessionDeps {
  locate: (sessionId: string) => Promise<SessionLocation | null>;
  /** The window's own opener, exactly what every chip did before. */
  openHere: (sessionId: string) => Promise<void> | void;
  openInProject: (target: { sessionId: string; workspacePath: string; sourceLabel: string }) => Promise<{ ok?: boolean; error?: string } | null | undefined>;
}

export type OpenSessionOutcome = 'here' | 'routed' | 'ignored';

export async function openSessionById(sessionId: string, deps: OpenSessionDeps): Promise<OpenSessionOutcome> {
  const id = sessionId?.trim();
  if (!id) return 'ignored';

  let location: SessionLocation | null = null;
  try {
    location = await deps.locate(id);
  } catch {
    location = null;
  }

  if (location?.foreign && location.workspacePath) {
    try {
      const result = await deps.openInProject({
        sessionId: id,
        workspacePath: location.workspacePath,
        sourceLabel: location.title?.trim() || `Session ${id.slice(0, 8)}`,
      });
      if (result?.ok) return 'routed';
    } catch {
      /* the local opener is the fallback */
    }
  }

  await deps.openHere(id);
  return 'here';
}

/** The production deps: the preload calls behind `locate` and `openInProject`. */
export function hostOpenSessionDeps(openHere: OpenSessionDeps['openHere']): OpenSessionDeps {
  return {
    locate: async (sessionId) => {
      const r = (await window.electronAPI.invoke('sessions:locate', { sessionId })) as
        | { workspacePath: string | null; foreign: boolean; title?: string | null }
        | null;
      return r ?? null;
    },
    openHere,
    openInProject: (target) =>
      window.electronAPI.invoke('sessions:open-in-project', target) as Promise<{ ok?: boolean; error?: string }>,
  };
}
