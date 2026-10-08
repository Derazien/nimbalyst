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
      });
    }
    expect(routesExitPlanToCliHook('claude-code-cli', false)).toBe(false);
    expect(resolveExitPlanCardMode('claude-code-cli', false)).toEqual({
      inTerminal: true,
      approveOrReviseOnly: false,
    });
  });

  it('keeps the SDK lane on its own flow and other terminal CLIs read-only', () => {
    expect(routesExitPlanToCliHook('claude-code', null)).toBe(false);
    expect(resolveExitPlanCardMode('claude-code', null)).toEqual({ inTerminal: false, approveOrReviseOnly: false });
    // Kimi has no ExitPlanMode hook, whatever main reports.
    expect(routesExitPlanToCliHook('kimi-code-cli', true)).toBe(false);
    expect(resolveExitPlanCardMode('kimi-code-cli', true)).toEqual({ inTerminal: true, approveOrReviseOnly: false });
  });
});

describe('sendCliExitPlanResponse', () => {
  it('sends approve and deny (with feedback) on the CLI channel, not the SDK one', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    await sendCliExitPlanResponse(invoke, 'sess', { approved: true });
    await sendCliExitPlanResponse(invoke, 'sess', { approved: false, feedback: 'smaller' });
    expect(invoke.mock.calls).toEqual([
      [CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, { sessionId: 'sess', decision: 'approve' }],
      [CLAUDE_CLI_EXIT_PLAN_RESPONSE_CHANNEL, { sessionId: 'sess', decision: 'deny', feedback: 'smaller' }],
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
