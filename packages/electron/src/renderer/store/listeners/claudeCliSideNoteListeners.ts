/**
 * Centralized IPC listener for `/btw` side notes on a `claude-code-cli` session.
 *
 * A side question deliberately produces no transcript row, so this event is the
 * ONLY way the renderer learns about it. Main sends one on submit (question, no
 * answer yet) and again once the answer is claimed, keyed by note id.
 *
 * Follows the centralized-listener architecture: components never subscribe to
 * IPC directly; this updates the atom SessionTranscript reads.
 */

import { store } from '../index';
import { sideNotesAtom, type SideNote } from '../atoms/claudeCliSideNotes';

interface SideNotePayload {
  sessionId: string;
  note: SideNote;
}

/**
 * Merge one note into a session's list, replacing the earlier version of the same
 * note so the answer lands on the question rather than appending a duplicate.
 */
export function mergeSideNote(existing: readonly SideNote[], incoming: SideNote): SideNote[] {
  const index = existing.findIndex(n => n.id === incoming.id);
  if (index === -1) return [...existing, incoming];
  const next = [...existing];
  next[index] = incoming;
  return next;
}

export function initClaudeCliSideNoteListeners(): () => void {
  const handleSideNote = (payload: SideNotePayload) => {
    const { sessionId, note } = payload ?? {};
    if (!sessionId || !note?.id) return;
    store.set(sideNotesAtom(sessionId), (current) => mergeSideNote(current, note));
  };

  return window.electronAPI.on('claude-cli:side-note', handleSideNote);
}
