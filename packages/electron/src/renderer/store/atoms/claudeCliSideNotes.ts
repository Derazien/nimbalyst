/**
 * `/btw` side notes for a `claude-code-cli` session.
 *
 * A side question is asked and answered without entering the conversation, so
 * these never appear as transcript rows. They live here for the session's
 * lifetime so the user can find what they asked without it polluting the thread.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export interface SideNote {
  id: string;
  question: string;
  /** Undefined while the answer is still coming, or when it was not claimable. */
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  /**
   * False when a turn was already running at submit: the CLI queued the command,
   * so its answer could not be told apart from the lead's and was left in the
   * transcript instead.
   */
  claimingAnswer: boolean;
}

/** Per-session side notes, oldest first. Written only by the IPC listener. */
export const sideNotesAtom = atomFamily((_sessionId: string) => atom<SideNote[]>([]));
