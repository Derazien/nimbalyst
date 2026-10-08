// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { cycleClaudeCliMode, CLAUDE_CLI_BACKTAB } from '../claudeCliModeCycle';
import {
  ClaudeCliModeTracker,
  bypassAvailableFromArgs,
  startingModeFromArgs,
} from '../claudeCliModeTracker';
import type { ClaudeCliPermissionMode } from '../../../../shared/claudeCliPermissionMode';

/** A fake CLI: each backtab advances through `order`; `stuck` ignores the key. */
function fakeCli(start: ClaudeCliPermissionMode | null, order: ClaudeCliPermissionMode[], stuck = false) {
  let mode = start;
  const writes: string[] = [];
  return {
    writes,
    deps: {
      write: (data: string) => {
        writes.push(data);
        if (stuck) return;
        const at = mode ? order.indexOf(mode) : -1;
        mode = order[(at + 1) % order.length];
      },
      readMode: () => mode,
      delay: async () => {},
    },
  };
}

const WITH_BYPASS: ClaudeCliPermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const WITHOUT_BYPASS: ClaudeCliPermissionMode[] = ['default', 'acceptEdits', 'plan'];

describe('cycleClaudeCliMode', () => {
  it('presses once with no target', async () => {
    const cli = fakeCli('default', WITH_BYPASS);
    expect(await cycleClaudeCliMode(cli.deps)).toEqual({ ok: true, mode: 'acceptEdits' });
    expect(cli.writes).toEqual([CLAUDE_CLI_BACKTAB]);
  });

  it('presses until the target is reported, and not once more', async () => {
    const cli = fakeCli('default', WITH_BYPASS);
    expect(await cycleClaudeCliMode(cli.deps, { target: 'bypassPermissions' })).toEqual({
      ok: true,
      mode: 'bypassPermissions',
    });
    expect(cli.writes).toHaveLength(3);
    const already = fakeCli('plan', WITH_BYPASS);
    expect(await cycleClaudeCliMode(already.deps, { target: 'plan' })).toEqual({ ok: true, mode: 'plan' });
    expect(already.writes).toHaveLength(0);
  });

  it('gives up after max presses', async () => {
    const cli = fakeCli('default', WITH_BYPASS);
    const result = await cycleClaudeCliMode(cli.deps, { target: 'bypassPermissions', maxPresses: 2 });
    expect(result).toEqual({ ok: false, mode: 'plan' });
    expect(cli.writes).toHaveLength(2);
  });

  it('stops after one full lap when the target is not in the cycle (bypass not enabled)', async () => {
    const cli = fakeCli('plan', WITHOUT_BYPASS);
    const result = await cycleClaudeCliMode(cli.deps, { target: 'bypassPermissions' });
    expect(result).toEqual({ ok: false, mode: 'plan' });
    expect(cli.writes).toHaveLength(3);
  });

  it('stops pressing when the mode never changes (dialog open)', async () => {
    const cli = fakeCli('default', WITH_BYPASS, true);
    const result = await cycleClaudeCliMode(cli.deps, { target: 'plan', waitMs: 200 });
    expect(result).toEqual({ ok: false, mode: 'default' });
    expect(cli.writes).toHaveLength(1);
  });
});

describe('ClaudeCliModeTracker', () => {
  const promptScreen = (footer: string) => ['done', '─'.repeat(40), '❯ ', '─'.repeat(40), footer];

  it('persists only changed, recognized readings and throttles bursts', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const timers: Array<() => void> = [];
    const tracker = new ClaudeCliModeTracker({
      persist: async (_id, _wp, patch) => {
        persisted.push({ ...patch });
      },
      setTimer: (fn) => timers.push(fn),
    });

    tracker.noteScreen('s1', '/wp', promptScreen('  ⏸ plan mode on (shift+tab to cycle)'));
    tracker.noteScreen('s1', '/wp', promptScreen('  ⏸ plan mode on (shift+tab to cycle)'));
    expect(timers).toHaveLength(1); // second push inside the window schedules nothing
    timers.shift()!();
    expect(tracker.getMode('s1')).toBe('plan');

    // Same reading again, then a dialog (null), then a real change.
    tracker.noteScreen('s1', '/wp', promptScreen('  ⏸ plan mode on'));
    timers.shift()!();
    tracker.noteScreen('s1', '/wp', [' Would you like to proceed?', ' ❯ 1. Yes', ' Esc to cancel']);
    timers.shift()!();
    expect(tracker.getMode('s1')).toBe('plan');
    tracker.noteScreen('s1', '/wp', promptScreen('  ⏵⏵ bypass permissions on (shift+tab to cycle)'));
    timers.shift()!();

    expect(persisted).toEqual([{ cliPermissionMode: 'plan' }, { cliPermissionMode: 'bypassPermissions' }]);
  });

  it('seeds from launch flags without inventing a mode for a resumed session', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const tracker = new ClaudeCliModeTracker({ persist: async (_i, _w, p) => void persisted.push({ ...p }) });
    tracker.seed('new', '/wp', { mode: 'plan', bypassAvailable: true });
    tracker.seed('resumed', '/wp', { mode: null, bypassAvailable: true });
    expect(persisted).toEqual([
      { cliPermissionMode: 'plan', cliBypassAvailable: true },
      { cliBypassAvailable: true },
    ]);
    expect(tracker.getMode('resumed')).toBeNull();
  });

  it('derives the starting mode and bypass reachability from spawn args', () => {
    expect(startingModeFromArgs(['--permission-mode', 'plan', '--allow-dangerously-skip-permissions'])).toBe('plan');
    expect(startingModeFromArgs(['--dangerously-skip-permissions'])).toBe('bypassPermissions');
    expect(startingModeFromArgs(['--model', 'opus'])).toBe('default');
    expect(startingModeFromArgs(['--resume', 'abc', '--allow-dangerously-skip-permissions'])).toBeNull();
    expect(bypassAvailableFromArgs(['--allow-dangerously-skip-permissions'])).toBe(true);
    expect(bypassAvailableFromArgs(['--permission-mode', 'plan'])).toBe(false);
  });
});
