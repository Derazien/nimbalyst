/**
 * `/btw` support for `claude-code-cli`: a side question that does not enter the
 * conversation.
 *
 * The CLI documents `/btw [question]` as "ask a side question without adding to
 * conversation history", and queues any command typed while the agent is
 * responding until the turn finishes. Typed into the composer today it travels as
 * ordinary text: the question is persisted as a user row and the answer as an
 * assistant row, so the one thing `/btw` exists to avoid is exactly what happens.
 *
 * ## Two halves, with very different confidence
 *
 * Suppressing the QUESTION is certain. We know what the user typed, so the user
 * row is simply not written.
 *
 * Suppressing the ANSWER is a guess, and a dangerous one: mistaking a lead turn
 * for the answer would delete the lead's output from the transcript. The CLI does
 * not label the reply, so the only handle is "the next assistant turn", and that
 * is only true when the session was IDLE at submit time. If a turn is already
 * running the CLI queues the command, the running turn's remaining messages
 * arrive first, and "the next turn" is somebody else's.
 *
 * So the answer is only claimed when the session was idle at submit. When it was
 * busy the question is still kept out of the transcript and the user is told the
 * side question is queued, but the answer is left in the transcript rather than
 * risking the lead's output. Better a side answer in the wrong place than a lead
 * turn that vanishes.
 *
 * Pure and dependency-free: the decision is testable without a session, a PTY, or
 * a database.
 */

/** Leading `/btw`, optionally with the question after it. */
const BTW_COMMAND_RE = /^\s*\/btw\b[ \t]*(.*)$/is;

export interface SideQuestionSubmission {
  /** The question text after the command word, empty when only `/btw` was typed. */
  question: string;
  /**
   * Whether the answer can be claimed off the transcript. False when a turn was
   * already running, because the CLI queues the command behind it.
   */
  canClaimAnswer: boolean;
}

/**
 * Recognise a `/btw` submission. Returns null for anything else, including a
 * `/btw` that is not the first thing on the line, since only a leading command
 * is what the CLI's readline executes.
 */
export function parseSideQuestion(
  prompt: string | undefined,
  options: { sessionIsBusy: boolean },
): SideQuestionSubmission | null {
  if (!prompt) return null;
  const match = BTW_COMMAND_RE.exec(prompt);
  if (!match) return null;
  return {
    question: match[1].trim(),
    canClaimAnswer: !options.sessionIsBusy,
  };
}

/** A side question and, once it arrives, its answer. */
export interface SideNote {
  id: string;
  question: string;
  /** Undefined until the answer is observed, or forever when it was not claimable. */
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  /** False when a turn was running, so the answer stays in the transcript. */
  claimingAnswer: boolean;
  /**
   * Set when a turn arrived while this note was waiting but did not look like a
   * side answer, so it was left in the conversation. The strip says so.
   */
  declinedReason?: 'did-work' | 'too-long' | 'too-late';
}

/**
 * A side answer is a short, plain reply that arrives promptly: no tool calls, not
 * far longer than an answer to a question, and not long after it was asked.
 *
 * This is a guard, not a classifier. The cost of the two mistakes is wildly
 * asymmetric: wrongly leaving a side answer in the conversation is a shrug, while
 * wrongly claiming a lead turn deletes the lead's output into a side panel. So
 * every clause is biased towards declining, and any single one declining is
 * enough.
 */
export function looksLikeSideAnswer(turn: {
  text: string;
  hasToolCalls: boolean;
  now: number;
  askedAt: number;
}): { ok: true } | { ok: false; reason: NonNullable<SideNote['declinedReason']> } {
  // A side question asks something; it does not send the agent off to work.
  if (turn.hasToolCalls) return { ok: false, reason: 'did-work' };
  if (turn.text.length > MAX_SIDE_ANSWER_CHARS) return { ok: false, reason: 'too-long' };
  if (turn.now - turn.askedAt > MAX_SIDE_ANSWER_WAIT_MS) return { ok: false, reason: 'too-late' };
  return { ok: true };
}

/** Generous: a side answer can be a paragraph, but not a work report. */
export const MAX_SIDE_ANSWER_CHARS = 2000;
/** The CLI answers a side question promptly; beyond this it is somebody else's turn. */
export const MAX_SIDE_ANSWER_WAIT_MS = 120_000;

interface SessionState {
  notes: SideNote[];
  /** The note waiting for the next assistant turn, when one can be claimed. */
  awaitingAnswer: SideNote | null;
}

const bySession = new Map<string, SessionState>();

function stateFor(sessionId: string): SessionState {
  let state = bySession.get(sessionId);
  if (!state) {
    state = { notes: [], awaitingAnswer: null };
    bySession.set(sessionId, state);
  }
  return state;
}

/**
 * Record a submitted side question. Returns the note, whose `claimingAnswer`
 * tells the caller whether to expect `claimSideAnswer` to fire.
 */
export function noteSideQuestion(
  sessionId: string,
  submission: SideQuestionSubmission,
  now: number,
): SideNote {
  const state = stateFor(sessionId);
  const note: SideNote = {
    id: `${sessionId}:${now}:${state.notes.length}`,
    question: submission.question,
    askedAt: now,
    claimingAnswer: submission.canClaimAnswer,
  };
  state.notes.push(note);
  // Only one question can be outstanding: a second one supersedes the first
  // rather than leaving two latches racing for the same turn.
  state.awaitingAnswer = submission.canClaimAnswer ? note : null;
  return note;
}

/**
 * Claim an observed assistant turn as the pending side answer.
 *
 * Returns the completed note when this turn was the answer, or null when there
 * is nothing waiting, in which case the caller persists the turn normally. Only
 * ever called for an UNATTRIBUTED turn: a sub-agent's turn is never a side
 * answer, and claiming one would hide that agent's work.
 */
export type SideAnswerOutcome =
  /** Nothing was waiting. Persist the turn normally. */
  | { outcome: 'none' }
  /** This turn is the answer. Do not persist it; show the note. */
  | { outcome: 'claimed'; note: SideNote }
  /** Something was waiting but this turn is not it. Persist it AND show the note. */
  | { outcome: 'declined'; note: SideNote };

export function claimSideAnswer(
  sessionId: string,
  turn: { text: string; hasToolCalls: boolean },
  now: number,
): SideAnswerOutcome {
  const state = bySession.get(sessionId);
  const pending = state?.awaitingAnswer;
  if (!state || !pending) return { outcome: 'none' };

  const verdict = looksLikeSideAnswer({
    text: turn.text,
    hasToolCalls: turn.hasToolCalls,
    now,
    askedAt: pending.askedAt,
  });

  // Either way the latch comes down. Leaving it armed after a rejection would
  // just point it at the NEXT lead turn, which is the failure this guards.
  state.awaitingAnswer = null;

  if (!verdict.ok) {
    pending.declinedReason = verdict.reason;
    return { outcome: 'declined', note: pending };
  }

  pending.answer = turn.text;
  pending.answeredAt = now;
  return { outcome: 'claimed', note: pending };
}

/** Whether a turn is currently expected to be a side answer. */
export function isAwaitingSideAnswer(sessionId: string): boolean {
  return !!bySession.get(sessionId)?.awaitingAnswer;
}

/** Every side note for this session, oldest first. */
export function getSideNotes(sessionId: string): readonly SideNote[] {
  return bySession.get(sessionId)?.notes ?? [];
}

/**
 * Give up on a pending claim without consuming a turn.
 *
 * Called when the session goes idle having produced nothing, so a latch left
 * armed by a question that errored cannot swallow an unrelated turn later.
 */
export function abandonPendingSideAnswer(sessionId: string): void {
  const state = bySession.get(sessionId);
  if (state) state.awaitingAnswer = null;
}

/** Drop the session's notes (call when its observation session ends). */
export function clearSideQuestions(sessionId: string): void {
  bySession.delete(sessionId);
}

/**
 * Push a side note to the window showing this workspace.
 *
 * A side note deliberately has no transcript row, so the renderer only ever
 * learns about it from this event. Best-effort: a missing window means the
 * popover simply does not update.
 */
export interface SideNoteWindow {
  webContents: { send: (channel: string, payload: unknown) => void };
}

export function broadcastSideNote(
  findWindow: (workspacePath: string) => SideNoteWindow | null,
  sessionId: string,
  workspacePath: string,
  note: SideNote,
): void {
  try {
    findWindow(workspacePath)?.webContents.send('claude-cli:side-note', { sessionId, note });
  } catch {
    // Never throw into the submit or observation path over a UI update.
  }
}
