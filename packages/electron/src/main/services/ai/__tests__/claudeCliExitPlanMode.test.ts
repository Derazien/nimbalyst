// @vitest-environment node
/**
 * The plan card answers the CLI's ExitPlanMode PreToolUse hook through a per-session parked
 * request. These cover the lifecycle a reader cannot see on screen: one request per session, a
 * newer request displacing the older, abort/timeout falling back to the CLI's own dialog, and the
 * blocked/settled bookkeeping staying with the request that is still parked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerExitPlanFromCard,
  getExitPlanAnswerPath,
  handleExitPlanHookRequest,
  hasPendingExitPlan,
  isExitPlanCardInteractive,
  parseExitPlanResponse,
  resetExitPlanModeStateForTests,
  resolveExitPlanAnswer,
  setExitPlanAnswerPath,
  waitForExitPlanAnswer,
} from '../claudeCliExitPlanMode';

afterEach(() => {
  resetExitPlanModeStateForTests();
  vi.useRealTimers();
});

describe('parseExitPlanResponse', () => {
  it('accepts approve and deny (trimming feedback) and rejects anything else', () => {
    expect(parseExitPlanResponse({ sessionId: 's', decision: 'approve' })).toEqual({
      sessionId: 's',
      answer: { decision: 'approve' },
    });
    expect(parseExitPlanResponse({ sessionId: 's', decision: 'deny', feedback: '  use sqlite ' })).toEqual({
      sessionId: 's',
      answer: { decision: 'deny', feedback: 'use sqlite' },
    });
    expect(parseExitPlanResponse({ sessionId: 's', decision: 'deny', feedback: '   ' })?.answer).toEqual({
      decision: 'deny',
    });
    expect(parseExitPlanResponse({ sessionId: 's', decision: 'approve-manual' })).toEqual({
      sessionId: 's',
      answer: { decision: 'approve-manual' },
    });
    expect(parseExitPlanResponse({ sessionId: 's', decision: 'ask' })).toBeNull();
    expect(parseExitPlanResponse({ decision: 'approve' })).toBeNull();
    expect(parseExitPlanResponse(null)).toBeNull();
  });
});

describe('pending plan approval registry', () => {
  it('resolves the parked request once and cleans up the session', async () => {
    const waiting = waitForExitPlanAnswer('s1');
    expect(hasPendingExitPlan('s1')).toBe(true);
    expect(resolveExitPlanAnswer('s1', { decision: 'deny', feedback: 'smaller' })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: 'deny', feedback: 'smaller' });
    expect(hasPendingExitPlan('s1')).toBe(false);
    // A second click, or an answer for a hook that already gave up, delivers to nobody.
    expect(resolveExitPlanAnswer('s1', { decision: 'approve' })).toBe(false);
  });

  it('keeps sessions apart', async () => {
    const a = waitForExitPlanAnswer('a');
    const b = waitForExitPlanAnswer('b');
    resolveExitPlanAnswer('b', { decision: 'approve' });
    await expect(b).resolves.toEqual({ decision: 'approve' });
    expect(hasPendingExitPlan('a')).toBe(true);
    resolveExitPlanAnswer('a', { decision: 'approve' });
    await a;
  });

  it('displaces an older request with ask, and the newer one stays answerable', async () => {
    const first = waitForExitPlanAnswer('s');
    const second = waitForExitPlanAnswer('s');
    await expect(first).resolves.toEqual({ decision: 'ask' });
    expect(hasPendingExitPlan('s')).toBe(true);
    resolveExitPlanAnswer('s', { decision: 'approve' });
    await expect(second).resolves.toEqual({ decision: 'approve' });
  });

  it('settles ask when the hook goes away (abort), including an already-aborted signal', async () => {
    const ctrl = new AbortController();
    const waiting = waitForExitPlanAnswer('s', { signal: ctrl.signal });
    ctrl.abort();
    await expect(waiting).resolves.toEqual({ decision: 'ask' });
    expect(hasPendingExitPlan('s')).toBe(false);

    const done = new AbortController();
    done.abort();
    await expect(waitForExitPlanAnswer('s', { signal: done.signal })).resolves.toEqual({ decision: 'ask' });
    expect(hasPendingExitPlan('s')).toBe(false);
  });

  it('settles ask after the max wait so the CLI dialog takes over', async () => {
    vi.useFakeTimers();
    const waiting = waitForExitPlanAnswer('s', { maxWaitMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(waiting).resolves.toEqual({ decision: 'ask' });
    expect(hasPendingExitPlan('s')).toBe(false);
  });

});

describe('answerExitPlanFromCard: hook path for ask projects, keystroke path for skip projects', () => {
  const screenOk = { ok: true as const, mode: 'bypassPermissions' as const, confirmed: true };

  it('ask project (hook): resolves the parked hook and never touches the terminal', async () => {
    setExitPlanAnswerPath('s', 'hook');
    const driveScreen = vi.fn();
    const waiting = waitForExitPlanAnswer('s');
    await expect(answerExitPlanFromCard('s', { decision: 'approve' }, { driveScreen })).resolves.toEqual({
      success: true,
      via: 'hook',
    });
    await expect(waiting).resolves.toEqual({ decision: 'approve' });
    expect(driveScreen).not.toHaveBeenCalled();
    // Nothing parked any more (the hook gave up): the card is told to use the terminal, still no keystrokes.
    const late = await answerExitPlanFromCard('s', { decision: 'approve' }, { driveScreen });
    expect(late).toMatchObject({ success: false, error: expect.stringContaining('terminal') });
    expect(driveScreen).not.toHaveBeenCalled();
  });

  it('approve-manual: the hook only ever sees plain approve (an ask project is already manual); the screen gets the manual answer', async () => {
    setExitPlanAnswerPath('hook-s', 'hook');
    const driveScreen = vi.fn();
    const waiting = waitForExitPlanAnswer('hook-s');
    await expect(answerExitPlanFromCard('hook-s', { decision: 'approve-manual' }, { driveScreen })).resolves.toEqual({
      success: true,
      via: 'hook',
    });
    await expect(waiting).resolves.toEqual({ decision: 'approve' });
    expect(driveScreen).not.toHaveBeenCalled();

    setExitPlanAnswerPath('screen-s', 'screen');
    const screenDrive = vi.fn(async () => ({ ok: true as const, mode: 'default' as const, confirmed: true }));
    const result = await answerExitPlanFromCard('screen-s', { decision: 'approve-manual' }, { driveScreen: screenDrive });
    expect(screenDrive).toHaveBeenCalledWith('screen-s', { decision: 'approve-manual' });
    expect(result).toMatchObject({ success: true, via: 'screen', mode: 'default' });
  });

  it('skip project (screen): drives the dialog and reports the confirmed mode, ignoring any parked hook', async () => {
    setExitPlanAnswerPath('s', 'screen');
    const driveScreen = vi.fn(async () => screenOk);
    const stray = waitForExitPlanAnswer('s');
    const result = await answerExitPlanFromCard('s', { decision: 'deny', feedback: 'smaller' }, { driveScreen });
    expect(driveScreen).toHaveBeenCalledWith('s', { decision: 'deny', feedback: 'smaller' });
    expect(result).toEqual({ success: true, via: 'screen', mode: 'bypassPermissions', bypassConfirmed: true });
    expect(hasPendingExitPlan('s')).toBe(true);
    resolveExitPlanAnswer('s', { decision: 'approve' });
    await stray;
  });

  it('skip project: an unverifiable screen becomes an "Answer in the terminal" refusal', async () => {
    setExitPlanAnswerPath('s', 'screen');
    const driveScreen = vi.fn(async () => ({ ok: false as const, reason: 'the plan dialog is not showing' }));
    await expect(answerExitPlanFromCard('s', { decision: 'approve' }, { driveScreen })).resolves.toEqual({
      success: false,
      error: 'Answer in the terminal: the plan dialog is not showing.',
    });
  });

  it('a session with no recorded path cannot be answered and is not interactive', async () => {
    const driveScreen = vi.fn();
    expect(getExitPlanAnswerPath('x')).toBe('none');
    expect(isExitPlanCardInteractive('x')).toBe(false);
    await expect(answerExitPlanFromCard('x', { decision: 'approve' }, { driveScreen })).resolves.toMatchObject({
      success: false,
    });
    setExitPlanAnswerPath('x', 'screen');
    expect(isExitPlanCardInteractive('x')).toBe(true);
  });
});

describe('handleExitPlanHookRequest', () => {
  function deps(isCli = true) {
    return {
      isCliSession: vi.fn(async () => isCli),
      markBlocked: vi.fn(),
      markSettled: vi.fn(),
    };
  }

  it('does not park a request for a non-CLI session or a missing id', async () => {
    const d = deps(false);
    await expect(handleExitPlanHookRequest({ sessionId: 's' }, d)).resolves.toEqual({ decision: 'ask' });
    await expect(handleExitPlanHookRequest({ sessionId: '' }, deps())).resolves.toEqual({ decision: 'ask' });
    expect(d.markBlocked).not.toHaveBeenCalled();
    expect(hasPendingExitPlan('s')).toBe(false);
  });

  it('marks the session blocked while parked and settled after the answer', async () => {
    const d = deps();
    const request = handleExitPlanHookRequest({ sessionId: 's' }, d);
    await vi.waitFor(() => expect(hasPendingExitPlan('s')).toBe(true));
    expect(d.markBlocked).toHaveBeenCalledTimes(1);
    expect(d.markSettled).not.toHaveBeenCalled();
    resolveExitPlanAnswer('s', { decision: 'approve' });
    await expect(request).resolves.toEqual({ decision: 'approve' });
    expect(d.markSettled).toHaveBeenCalledTimes(1);
  });

  it('leaves the blocked flag to the replacement when a request is displaced', async () => {
    const d = deps();
    const older = handleExitPlanHookRequest({ sessionId: 's' }, d);
    await vi.waitFor(() => expect(hasPendingExitPlan('s')).toBe(true));
    const newer = handleExitPlanHookRequest({ sessionId: 's' }, d);
    await expect(older).resolves.toEqual({ decision: 'ask' });
    expect(d.markSettled).not.toHaveBeenCalled();
    resolveExitPlanAnswer('s', { decision: 'approve' });
    await newer;
    expect(d.markSettled).toHaveBeenCalledTimes(1);
  });
});
