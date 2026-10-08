/**
 * NIM-806 Phase 4 (Direction A) — the `--settings` PreToolUse-hook payload and
 * the Electron-as-Node hook command. `--permission-prompt-tool` is ignored by the
 * interactive CLI; a PreToolUse hook is the mechanism that works interactively.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPermissionHookSettings,
  buildPermissionHookSettingsJson,
  buildElectronNodeHookCommand,
  PERMISSION_HOOK_MATCHER,
  PERMISSION_HOOK_TIMEOUT_SEC,
  buildClaudeCliHookSettings,
  buildExitPlanHookCommand,
  EXIT_PLAN_HOOK_MATCHER,
  EXIT_PLAN_HOOK_MODE,
  EXIT_PLAN_HOOK_TIMEOUT_SEC,
} from '../claudeCliPermissionHookConfig';

describe('buildPermissionHookSettings', () => {
  it('registers a single PreToolUse command hook with the default matcher + timeout', () => {
    const s = buildPermissionHookSettings({ command: 'run-hook' });
    expect(s.hooks.PreToolUse).toHaveLength(1);
    const entry = s.hooks.PreToolUse[0];
    expect(entry.matcher).toBe(PERMISSION_HOOK_MATCHER);
    expect(entry.hooks[0]).toEqual({ type: 'command', command: 'run-hook', timeout: PERMISSION_HOOK_TIMEOUT_SEC });
  });

  it('matcher covers the prompting built-ins but not read-only tools', () => {
    expect(PERMISSION_HOOK_MATCHER).toContain('Bash');
    expect(PERMISSION_HOOK_MATCHER).toContain('Edit');
    expect(PERMISSION_HOOK_MATCHER).toContain('Write');
    expect(PERMISSION_HOOK_MATCHER).not.toContain('Read');
    expect(PERMISSION_HOOK_MATCHER).not.toContain('Grep');
  });

  it('honors custom matcher + timeout', () => {
    const s = buildPermissionHookSettings({ command: 'x', matcher: 'Bash', timeoutSec: 30 });
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
  });

  it('JSON form round-trips', () => {
    const json = buildPermissionHookSettingsJson({ command: 'c' });
    expect(JSON.parse(json)).toEqual(buildPermissionHookSettings({ command: 'c' }));
  });
});

describe('buildElectronNodeHookCommand', () => {
  it('runs the script under Electron-as-Node with quoted paths', () => {
    const cmd = buildElectronNodeHookCommand('/Apps/My App/electron', '/Apps/My App/resources/hook.cjs');
    expect(cmd).toBe('ELECTRON_RUN_AS_NODE=1 "/Apps/My App/electron" "/Apps/My App/resources/hook.cjs"');
  });
});

describe('buildClaudeCliHookSettings (gate + ExitPlanMode)', () => {
  const exit = buildExitPlanHookCommand('/Apps/electron', '/Apps/hook.cjs');

  it('ask projects: the gate stays first, the ExitPlanMode hook rides along with a long timeout', () => {
    const s = buildClaudeCliHookSettings({ gateCommand: 'gate', exitPlanCommand: exit });
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]).toEqual(buildPermissionHookSettings({ command: 'gate' }).hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse[1]).toEqual({
      matcher: EXIT_PLAN_HOOK_MATCHER,
      hooks: [{ type: 'command', command: exit, timeout: EXIT_PLAN_HOOK_TIMEOUT_SEC }],
    });
    // Longer than a permission prompt: a plan can sit unread, and the hook must outlive the card.
    expect(EXIT_PLAN_HOOK_TIMEOUT_SEC).toBeGreaterThan(PERMISSION_HOOK_TIMEOUT_SEC);
  });

  it('skip projects: only the ExitPlanMode hook, and the gate matcher is not registered', () => {
    const s = buildClaudeCliHookSettings({ exitPlanCommand: exit });
    expect(s.hooks.PreToolUse.map((h) => h.matcher)).toEqual(['ExitPlanMode']);
  });

  it('runs the same script in exit-plan-mode via argv', () => {
    expect(exit).toBe(`ELECTRON_RUN_AS_NODE=1 "/Apps/electron" "/Apps/hook.cjs" ${EXIT_PLAN_HOOK_MODE}`);
  });
});
