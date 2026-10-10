// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL,
  resolveExitPlanCardMode,
  routesExitPlanToCliHook,
  sendCliExitPlanResponse,
} from '../claudeCliExitPlanRouting';

describe('where the ExitPlanMode card answers', () => {
  it('claude-code-cli answers the hook, unless main says no hook is installed', () => {
    for (const known of [true, null]) {
      expect(routesExitPlanToCliHook('claude-code-cli', known)).toBe(true);
      expect(resolveExitPlanCardMode('claude-code-cli', known)).toEqual({
        inTerminal: false,
        approveOrReviseOnly: true,
        canApproveManual: false,
      });
    }
    expect(routesExitPlanToCliHook('claude-code-cli', false)).toBe(false);
    expect(resolveExitPlanCardMode('claude-code-cli', false)).toEqual({
      inTerminal: true,
      approveOrReviseOnly: false,
      canApproveManual: false,
    });
  });

  it('keeps the SDK lane on its own flow and other terminal CLIs read-only', () => {
    expect(routesExitPlanToCliHook('claude-code', null)).toBe(false);
    expect(resolveExitPlanCardMode('claude-code', null, 'screen')).toEqual({
      inTerminal: false,
      approveOrReviseOnly: false,
      canApproveManual: false,
    });
    // Kimi has no ExitPlanMode hook, whatever main reports.
    expect(routesExitPlanToCliHook('kimi-code-cli', true)).toBe(false);
    expect(resolveExitPlanCardMode('kimi-code-cli', true)).toEqual({
      inTerminal: true,
      approveOrReviseOnly: false,
      canApproveManual: false,
    });
  });

  it('offers ask-before-each-edit only on the keystroke path, where approve would switch to bypass', () => {
    expect(resolveExitPlanCardMode('claude-code-cli', true, 'screen').canApproveManual).toBe(true);
    // Ask project: approve already lands in manual mode, so a second button would be a duplicate.
    expect(resolveExitPlanCardMode('claude-code-cli', true, 'hook').canApproveManual).toBe(false);
    expect(resolveExitPlanCardMode('claude-code-cli', null, 'screen').canApproveManual).toBe(true);
    expect(resolveExitPlanCardMode('claude-code-cli', false, 'screen').canApproveManual).toBe(false);
  });
});

describe('sendCliExitPlanResponse', () => {
  it('sends approve and deny (with feedback) on the CLI channel, not the SDK one', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    await sendCliExitPlanResponse(invoke, 'sess', { approved: true });
    await sendCliExitPlanResponse(invoke, 'sess', { approved: false, feedback: 'smaller' });
    await sendCliExitPlanResponse(invoke, 'sess', { approved: true, manualEdits: true });
    expect(invoke.mock.calls).toEqual([
      [CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, { sessionId: 'sess', decision: 'approve' }],
      [CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, { sessionId: 'sess', decision: 'deny', feedback: 'smaller' }],
      [CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, { sessionId: 'sess', decision: 'approve-manual' }],
    ]);
    expect(CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL).not.toBe('ai:exitPlanModeConfirmResponse');
  });

  it('throws when nothing was waiting so the card reverts to pending', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'No plan approval is waiting' });
    await expect(sendCliExitPlanResponse(invoke, 'sess', { approved: true })).rejects.toThrow(
      'No plan approval is waiting',
    );
    await expect(sendCliExitPlanResponse(vi.fn().mockResolvedValue(undefined), 's', { approved: true })).rejects.toThrow();
  });
});
