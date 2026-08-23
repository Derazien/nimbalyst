// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  abandonPendingSideAnswer,
  claimSideAnswer,
  clearSideQuestions,
  getSideNotes,
  isAwaitingSideAnswer,
  noteSideQuestion,
  parseSideQuestion,
} from '../claudeCliSideQuestion';

const SID = 'session-1';
const idle = { sessionIsBusy: false };
const busy = { sessionIsBusy: true };

describe('parseSideQuestion', () => {
  it('recognises a leading /btw and takes the question after it', () => {
    expect(parseSideQuestion('/btw what model is this session on?', idle)).toEqual({
      question: 'what model is this session on?',
      canClaimAnswer: true,
    });
  });

  it('accepts the bare command and any casing', () => {
    expect(parseSideQuestion('/BTW', idle)?.question).toBe('');
    expect(parseSideQuestion('  /btw   spaced out  ', idle)?.question).toBe('spaced out');
  });

  it('ignores /btw that is not the command the CLI would run', () => {
    // Only a leading command reaches the CLI's readline as a command.
    expect(parseSideQuestion('remind me to /btw later', idle)).toBeNull();
    expect(parseSideQuestion('/btwitter is not this command', idle)).toBeNull();
    expect(parseSideQuestion('', idle)).toBeNull();
    expect(parseSideQuestion(undefined, idle)).toBeNull();
  });

  it('refuses to claim the answer when a turn is already running', () => {
    // The CLI queues the command behind the running turn, so "the next assistant
    // turn" belongs to the lead, not to this question.
    expect(parseSideQuestion('/btw quick one', busy)).toEqual({
      question: 'quick one',
      canClaimAnswer: false,
    });
  });
});

describe('side note lifecycle', () => {
  beforeEach(() => clearSideQuestions(SID));

  it('claims the next assistant turn as the answer when asked while idle', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw which model?', idle)!, 1000);
    expect(isAwaitingSideAnswer(SID)).toBe(true);

    const note = claimSideAnswer(SID, 'Opus 5.', 2000);

    expect(note?.question).toBe('which model?');
    expect(note?.answer).toBe('Opus 5.');
    expect(note?.answeredAt).toBe(2000);
    expect(isAwaitingSideAnswer(SID)).toBe(false);
  });

  it('claims only one turn, so the turn after the answer is left alone', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw one', idle)!, 1000);
    claimSideAnswer(SID, 'answered', 2000);

    expect(claimSideAnswer(SID, 'a normal lead turn', 3000)).toBeNull();
  });

  it('never claims a turn for a question asked while busy', () => {
    // The question still stays out of the transcript; the answer is left in it
    // rather than risking the lead's own output.
    const note = noteSideQuestion(SID, parseSideQuestion('/btw queued one', busy)!, 1000);

    expect(note.claimingAnswer).toBe(false);
    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, 'lead output', 2000)).toBeNull();
  });

  it('lets a second question supersede an unanswered first rather than racing it', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw first', idle)!, 1000);
    noteSideQuestion(SID, parseSideQuestion('/btw second', idle)!, 1100);

    const claimed = claimSideAnswer(SID, 'the answer', 2000);

    expect(claimed?.question).toBe('second');
    expect(getSideNotes(SID).map(n => n.question)).toEqual(['first', 'second']);
    expect(getSideNotes(SID)[0].answer).toBeUndefined();
  });

  it('a busy question clears a pending claim instead of leaving it armed', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw first', idle)!, 1000);
    noteSideQuestion(SID, parseSideQuestion('/btw second', busy)!, 1100);

    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, 'lead output', 2000)).toBeNull();
  });

  it('abandons a pending claim so a failed question cannot swallow a later turn', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw errored', idle)!, 1000);
    abandonPendingSideAnswer(SID);

    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, 'much later lead turn', 9000)).toBeNull();
    expect(getSideNotes(SID)[0].answer).toBeUndefined();
  });

  it('keeps notes per session and clears them together', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw mine', idle)!, 1000);
    expect(getSideNotes('other-session')).toEqual([]);

    clearSideQuestions(SID);
    expect(getSideNotes(SID)).toEqual([]);
  });
});
