/**
 * Side notes for a `claude-code-cli` session: the `/btw` questions asked and
 * answered without entering the conversation.
 *
 * They have no transcript rows by design, so without this strip a side answer
 * would have nowhere to appear at all. Collapsed by default and hidden entirely
 * when the session has never asked one, so it costs nothing for everyone else.
 */

import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sideNotesAtom } from '../../store/atoms/claudeCliSideNotes';

interface SideNotesStripProps {
  sessionId: string;
}

export const SideNotesStrip: React.FC<SideNotesStripProps> = ({ sessionId }) => {
  const notes = useAtomValue(sideNotesAtom(sessionId));
  const [expanded, setExpanded] = useState(false);

  if (notes.length === 0) return null;

  const latest = notes[notes.length - 1];
  const pending = notes.filter(n => n.claimingAnswer && !n.answer).length;

  return (
    <div className="side-notes-strip border-t border-[var(--nim-border)] text-xs">
      <button
        type="button"
        className="side-notes-strip-toggle flex w-full items-center gap-2 bg-transparent border-none px-3 py-1.5 cursor-pointer text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={14} />
        <span>Side notes ({notes.length})</span>
        {pending > 0 && (
          <span className="side-notes-strip-pending text-[var(--nim-text-muted)]">
            waiting for an answer
          </span>
        )}
        {!expanded && (
          <span className="side-notes-strip-preview truncate text-[var(--nim-text-muted)]">
            {latest.question}
          </span>
        )}
      </button>

      {expanded && (
        <ul className="side-notes-strip-list m-0 list-none px-3 pb-2 flex flex-col gap-2">
          {notes.map(note => (
            <li key={note.id} className="side-notes-strip-item flex flex-col gap-0.5">
              <span className="side-notes-strip-question text-[var(--nim-text)]">
                {note.question || '(no question)'}
              </span>
              {note.answer ? (
                <span className="side-notes-strip-answer whitespace-pre-wrap text-[var(--nim-text-muted)]">
                  {note.answer}
                </span>
              ) : note.claimingAnswer ? (
                <span className="side-notes-strip-waiting text-[var(--nim-text-muted)] italic">
                  Waiting for the answer.
                </span>
              ) : (
                // The CLI queues a command typed mid-turn, and once queued its
                // answer cannot be told apart from the lead's, so it is left in
                // the conversation rather than risking the lead's own output.
                <span className="side-notes-strip-queued text-[var(--nim-text-muted)] italic">
                  Asked during a turn, so the answer appears in the conversation.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
