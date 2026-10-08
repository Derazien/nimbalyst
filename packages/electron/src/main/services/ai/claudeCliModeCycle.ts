/**
 * Drives the genuine CLI's Shift+Tab permission-mode cycle from Nimbalyst.
 *
 * The CLI offers no way to set a mode directly, so a requested mode is reached by
 * pressing Shift+Tab (the backtab sequence) and reading back what the CLI reports
 * after each press. Write and read are injected so the loop is testable without a
 * PTY: `readMode` returns the last mode the footer detector reported.
 */

import type { ClaudeCliPermissionMode } from '../../../shared/claudeCliPermissionMode';

/** Shift+Tab as the terminal sends it. */
export const CLAUDE_CLI_BACKTAB = '\x1b[Z';

export const CLAUDE_CLI_MODE_MAX_PRESSES = 6;
export const CLAUDE_CLI_MODE_WAIT_MS = 1500;
const POLL_MS = 50;

export interface CycleClaudeCliModeDeps {
  write: (data: string) => void;
  /** Last mode the detector reported for this session (null = never detected). */
  readMode: () => ClaudeCliPermissionMode | null;
  delay: (ms: number) => Promise<void>;
}

export interface CycleClaudeCliModeOptions {
  /** Omit to press once. */
  target?: ClaudeCliPermissionMode;
  maxPresses?: number;
  waitMs?: number;
}

export interface CycleClaudeCliModeResult {
  /** True when the requested outcome was reached (no target: the press was sent). */
  ok: boolean;
  /** The mode reported after the last press, or the starting mode if nothing was pressed. */
  mode: ClaudeCliPermissionMode | null;
}

/** Wait until the reported mode differs from `before` (and is known), or time out. */
async function waitForModeChange(
  before: ClaudeCliPermissionMode | null,
  deps: CycleClaudeCliModeDeps,
  waitMs: number,
): Promise<ClaudeCliPermissionMode | null> {
  let waited = 0;
  for (;;) {
    const now = deps.readMode();
    if (now !== null && now !== before) return now;
    if (waited >= waitMs) return null;
    await deps.delay(POLL_MS);
    waited += POLL_MS;
  }
}

export async function cycleClaudeCliMode(
  deps: CycleClaudeCliModeDeps,
  options: CycleClaudeCliModeOptions = {},
): Promise<CycleClaudeCliModeResult> {
  const maxPresses = options.maxPresses ?? CLAUDE_CLI_MODE_MAX_PRESSES;
  const waitMs = options.waitMs ?? CLAUDE_CLI_MODE_WAIT_MS;
  const start = deps.readMode();

  if (!options.target) {
    deps.write(CLAUDE_CLI_BACKTAB);
    const changed = await waitForModeChange(start, deps, waitMs);
    return { ok: true, mode: changed ?? deps.readMode() };
  }
  if (start === options.target) return { ok: true, mode: start };

  let current = start;
  const seen = new Set<ClaudeCliPermissionMode>();
  if (start) seen.add(start);
  for (let press = 0; press < maxPresses; press += 1) {
    deps.write(CLAUDE_CLI_BACKTAB);
    const next = await waitForModeChange(current, deps, waitMs);
    // The footer never changed: the CLI is busy with a dialog or ignored the key.
    // Pressing more would only queue blind keystrokes, so stop.
    if (next === null) return { ok: false, mode: deps.readMode() };
    current = next;
    if (current === options.target) return { ok: true, mode: current };
    // A full lap without meeting the target means it is not in this session's
    // cycle (bypass was not enabled at launch); the lap leaves the mode as it was.
    if (seen.has(current)) return { ok: false, mode: current };
    seen.add(current);
  }
  return { ok: false, mode: current };
}
