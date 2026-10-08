/**
 * Pure builders for the genuine `claude-code-cli` PreToolUse permission hook
 * (NIM-806 Phase 4, Direction A). Kept free of Electron so the `--settings`
 * payload and hook command string are unit-testable.
 *
 * Why a hook (not `--permission-prompt-tool`): the latter is silently ignored by
 * the interactive CLI (verified live — native TUI prompt still showed). A
 * `PreToolUse` hook returning `permissionDecision` IS honored interactively, so
 * we register one via `--settings` that calls back into Nimbalyst's loopback
 * `/permission` endpoint (which renders the ToolPermission widget).
 */

/**
 * Built-in tools we intercept for a GUI permission prompt. Read-only tools
 * (Read/Glob/Grep) are intentionally omitted — the CLI auto-allows them, so
 * routing them through the hook would add needless round-trips. Bash/Edit/Write
 * and friends are the ones that otherwise show the native prompt.
 */
export const PERMISSION_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch';

/** Default hook timeout (seconds). Generous — a human may take a while to answer. */
export const PERMISSION_HOOK_TIMEOUT_SEC = 600;

export interface PermissionHookSettings {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

/**
 * Build the `--settings` object registering the PreToolUse permission hook.
 * `command` is the full shell command the CLI runs (e.g. an Electron-as-Node
 * invocation of the hook script).
 */
export function buildPermissionHookSettings(args: {
  command: string;
  matcher?: string;
  timeoutSec?: number;
}): PermissionHookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: args.matcher ?? PERMISSION_HOOK_MATCHER,
          hooks: [
            {
              type: 'command',
              command: args.command,
              timeout: args.timeoutSec ?? PERMISSION_HOOK_TIMEOUT_SEC,
            },
          ],
        },
      ],
    },
  };
}

/** JSON string for `--settings` (the CLI accepts a JSON string or a file path). */
export function buildPermissionHookSettingsJson(args: {
  command: string;
  matcher?: string;
  timeoutSec?: number;
}): string {
  return JSON.stringify(buildPermissionHookSettings(args));
}

/**
 * Build the hook command that runs the `.cjs` script under Electron-as-Node so
 * we never depend on a `node` binary being on the CLI's PATH. The
 * `ELECTRON_RUN_AS_NODE=1` prefix is scoped to this command only (not the whole
 * CLI env). Both paths are quoted for spaces (e.g. "Application Support").
 */
export function buildElectronNodeHookCommand(execPath: string, scriptPath: string): string {
  return `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${scriptPath}"`;
}

/** Tool whose approval Nimbalyst answers from its plan card (PreToolUse, not the permission gate). */
export const EXIT_PLAN_HOOK_MATCHER = 'ExitPlanMode';

/**
 * Argv mode that makes `claudeCliPermissionHook.cjs` run its ExitPlanMode branch. One script
 * serves both hooks so nothing new has to be packaged.
 */
export const EXIT_PLAN_HOOK_MODE = 'exit-plan-mode';

/**
 * The hook blocks until the user answers the plan card, which can be a long read. The script's
 * own request timeout stays just under this so the CLI never has to kill it.
 */
export const EXIT_PLAN_HOOK_TIMEOUT_SEC = 3600;

/**
 * No ExitPlanMode hook in projects that skip permissions. Live spike on CLI 2.1.295: a
 * `PreToolUse` allow skips the plan dialog but the CLI then continues in `default` ("manual
 * mode"), not bypass, and a `PermissionRequest` hook's `setMode` is ignored for ExitPlanMode. Only
 * the dialog's own option 1 switches to bypass, so those projects are answered by keystrokes into
 * the dialog instead (claudeCliPlanDialog.ts); the card is driven by the ExitPlanMode tool_use the
 * proxy already observes, no hook needed.
 */

export interface ClaudeCliHookSettings {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

/**
 * Build the `--settings` object for every hook a `claude-code-cli` session can carry: the
 * Bash/Edit/Write permission gate (ask projects only) and the ExitPlanMode plan-card hook.
 * The gate entry stays first so existing consumers reading `PreToolUse[0]` keep working.
 */
export function buildClaudeCliHookSettings(args: {
  gateCommand?: string;
  exitPlanCommand?: string;
}): ClaudeCliHookSettings {
  const PreToolUse: ClaudeCliHookSettings['hooks']['PreToolUse'] = [];
  if (args.gateCommand) {
    PreToolUse.push(
      ...buildPermissionHookSettings({ command: args.gateCommand }).hooks.PreToolUse,
    );
  }
  if (args.exitPlanCommand) {
    PreToolUse.push({
      matcher: EXIT_PLAN_HOOK_MATCHER,
      hooks: [{ type: 'command', command: args.exitPlanCommand, timeout: EXIT_PLAN_HOOK_TIMEOUT_SEC }],
    });
  }
  return { hooks: { PreToolUse } };
}

export function buildClaudeCliHookSettingsJson(args: {
  gateCommand?: string;
  exitPlanCommand?: string;
}): string {
  return JSON.stringify(buildClaudeCliHookSettings(args));
}

/** Command for the ExitPlanMode hook: the permission-hook script run in its `exit-plan-mode` mode. */
export function buildExitPlanHookCommand(execPath: string, scriptPath: string): string {
  return `${buildElectronNodeHookCommand(execPath, scriptPath)} ${EXIT_PLAN_HOOK_MODE}`;
}
