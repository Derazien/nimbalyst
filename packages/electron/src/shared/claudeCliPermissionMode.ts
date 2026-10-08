/**
 * Permission modes of the genuine `claude` CLI, as the Shift+Tab cycle exposes
 * them. Shared by the main-process footer detector and the renderer mode chip.
 *
 * Persisted in session metadata as `cliPermissionMode`; readers must tolerate the
 * key being absent (sessions created before the mode was tracked) or holding a
 * value this build does not know.
 */

export type ClaudeCliPermissionMode =
  | 'plan'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'auto'
  | 'default';

export const CLAUDE_CLI_PERMISSION_MODES: readonly ClaudeCliPermissionMode[] = [
  'plan',
  'bypassPermissions',
  'acceptEdits',
  'auto',
  'default',
];

/** Short chip labels. */
export const CLAUDE_CLI_PERMISSION_MODE_LABELS: Record<ClaudeCliPermissionMode, string> = {
  plan: 'Plan',
  bypassPermissions: 'Bypass',
  acceptEdits: 'Edits',
  default: 'Manual',
  auto: 'Auto',
};

export function parseClaudeCliPermissionMode(value: unknown): ClaudeCliPermissionMode | null {
  return typeof value === 'string' && (CLAUDE_CLI_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as ClaudeCliPermissionMode)
    : null;
}

/**
 * The CLI mode a plan/agent chip toggle requests. Into plan is always `plan`; out
 * of plan it is bypass when the session's CLI can reach bypass, else the default
 * (manual) mode.
 */
export function claudeCliTargetForChipMode(
  newMode: 'planning' | 'agent',
  bypassAvailable: boolean,
): ClaudeCliPermissionMode {
  if (newMode === 'planning') return 'plan';
  return bypassAvailable ? 'bypassPermissions' : 'default';
}
