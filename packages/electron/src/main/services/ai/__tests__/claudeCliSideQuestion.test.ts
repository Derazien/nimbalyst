// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  abandonPendingSideAnswer,
  claimSideAnswer,
  clearSideQuestions,
  getSideNotes,
  isAwaitingSideAnswer,
  noteSideQuestion,
  looksLikeSideAnswer,
  parseSideQuestion,
  MAX_SIDE_ANSWER_CHARS,
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

    const result = claimSideAnswer(SID, { text: 'Opus 5.', hasToolCalls: false }, 2000);
    const note = result.outcome === 'claimed' ? result.note : null;

    expect(note?.question).toBe('which model?');
    expect(note?.answer).toBe('Opus 5.');
    expect(note?.answeredAt).toBe(2000);
    expect(isAwaitingSideAnswer(SID)).toBe(false);
  });

  it('claims only one turn, so the turn after the answer is left alone', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw one', idle)!, 1000);
    claimSideAnswer(SID, { text: 'answered', hasToolCalls: false }, 2000);

    expect(claimSideAnswer(SID, { text: 'a normal lead turn', hasToolCalls: false }, 3000).outcome).toBe('none');
  });

  it('never claims a turn for a question asked while busy', () => {
    // The question still stays out of the transcript; the answer is left in it
    // rather than risking the lead's own output.
    const note = noteSideQuestion(SID, parseSideQuestion('/btw queued one', busy)!, 1000);

    expect(note.claimingAnswer).toBe(false);
    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, { text: 'lead output', hasToolCalls: false }, 2000).outcome).toBe('none');
  });

  it('lets a second question supersede an unanswered first rather than racing it', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw first', idle)!, 1000);
    noteSideQuestion(SID, parseSideQuestion('/btw second', idle)!, 1100);

    const result = claimSideAnswer(SID, { text: 'the answer', hasToolCalls: false }, 2000);
    const claimed = result.outcome === 'claimed' ? result.note : null;

    expect(claimed?.question).toBe('second');
    expect(getSideNotes(SID).map(n => n.question)).toEqual(['first', 'second']);
    expect(getSideNotes(SID)[0].answer).toBeUndefined();
  });

  it('a busy question clears a pending claim instead of leaving it armed', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw first', idle)!, 1000);
    noteSideQuestion(SID, parseSideQuestion('/btw second', busy)!, 1100);

    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, { text: 'lead output', hasToolCalls: false }, 2000).outcome).toBe('none');
  });

  it('abandons a pending claim so a failed question cannot swallow a later turn', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw errored', idle)!, 1000);
    abandonPendingSideAnswer(SID);

    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, { text: 'much later lead turn', hasToolCalls: false }, 9000).outcome).toBe('none');
    expect(getSideNotes(SID)[0].answer).toBeUndefined();
  });

  it('keeps notes per session and clears them together', () => {
    noteSideQuestion(SID, parseSideQuestion('/btw mine', idle)!, 1000);
    expect(getSideNotes('other-session')).toEqual([]);

    clearSideQuestions(SID);
    expect(getSideNotes(SID)).toEqual([]);
  });
});

describe('the side-answer guard', () => {
  beforeEach(() => clearSideQuestions(SID));

  const ask = () => noteSideQuestion(SID, parseSideQuestion('/btw which model?', idle)!, 1000);

  it('declines a turn that used tools, and leaves it in the conversation', () => {
    // A side question asks something; it does not send the agent off to work.
    // This is the shape that would otherwise eat a lead turn.
    ask();
    const result = claimSideAnswer(SID, { text: 'Editing the file now.', hasToolCalls: true }, 2000);

    expect(result.outcome).toBe('declined');
    expect(result.outcome === 'declined' && result.note.declinedReason).toBe('did-work');
    expect(result.outcome === 'declined' && result.note.answer).toBeUndefined();
  });

  it('declines a reply far longer than an answer to a question', () => {
    ask();
    const long = 'x'.repeat(MAX_SIDE_ANSWER_CHARS + 1);
    const result = claimSideAnswer(SID, { text: long, hasToolCalls: false }, 2000);

    expect(result.outcome === 'declined' && result.note.declinedReason).toBe('too-long');
  });

  it('declines a reply that arrives long after the question', () => {
    ask();
    const result = claimSideAnswer(SID, { text: 'late', hasToolCalls: false }, 1000 + 121_000);

    expect(result.outcome === 'declined' && result.note.declinedReason).toBe('too-late');
  });

  it('lowers the latch on a decline, so it cannot then take the NEXT lead turn', () => {
    // Leaving it armed after rejecting one turn just points it at the next one,
    // which is the exact failure this guard exists to prevent.
    ask();
    claimSideAnswer(SID, { text: 'working', hasToolCalls: true }, 2000);

    expect(isAwaitingSideAnswer(SID)).toBe(false);
    expect(claimSideAnswer(SID, { text: 'Opus 5.', hasToolCalls: false }, 3000).outcome).toBe('none');
  });

  it('still claims a short plain prompt reply', () => {
    ask();
    const result = claimSideAnswer(SID, { text: 'Opus 5.', hasToolCalls: false }, 2000);

    expect(result.outcome).toBe('claimed');
    expect(result.outcome === 'claimed' && result.note.answer).toBe('Opus 5.');
  });
});

describe('looksLikeSideAnswer', () => {
  const base = { text: 'short', hasToolCalls: false, now: 1000, askedAt: 1000 };

  it('accepts a short, plain, prompt reply', () => {
    expect(looksLikeSideAnswer(base)).toEqual({ ok: true });
  });

  it('any single clause failing is enough to decline', () => {
    // Biased towards declining: leaving a side answer in the conversation is a
    // shrug, claiming a lead turn deletes the lead's output.
    expect(looksLikeSideAnswer({ ...base, hasToolCalls: true })).toEqual({ ok: false, reason: 'did-work' });
    expect(looksLikeSideAnswer({ ...base, text: 'x'.repeat(MAX_SIDE_ANSWER_CHARS + 1) }))
      .toEqual({ ok: false, reason: 'too-long' });
    expect(looksLikeSideAnswer({ ...base, now: 1000 + 200_000 })).toEqual({ ok: false, reason: 'too-late' });
  });
});
