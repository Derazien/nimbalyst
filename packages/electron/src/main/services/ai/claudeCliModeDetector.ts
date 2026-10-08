/**
 * Reads the genuine `claude` CLI's live permission mode off the terminal screen.
 *
 * The CLI states its mode as footer text under the prompt box (for example
 * "plan mode on (shift+tab to cycle)"); the default mode shows no mode text. The
 * session .jsonl only records `permission-mode` per user prompt, so it lags and is
 * not usable for live tracking. Pure on purpose: the caller owns the screen model.
 */

import type { ClaudeCliPermissionMode } from '../../../shared/claudeCliPermissionMode';

/** How many non-empty lines from the bottom of the screen are considered at all. */
const TAIL_LINES = 8;
/** The mode footer sits at the very bottom, below the prompt box. */
const FOOTER_LINES = 4;

// Footer glyphs vary by CLI version (pause and double-play icons), so the match is
// anchored after at most a few non-letter characters rather than on a fixed prefix.
const MODE_FOOTERS: ReadonlyArray<{ mode: ClaudeCliPermissionMode; pattern: RegExp }> = [
  { mode: 'plan', pattern: /^[^\p{L}\p{N}]{0,6}plan mode on\b/iu },
  { mode: 'bypassPermissions', pattern: /^[^\p{L}\p{N}]{0,6}bypass permissions on\b/iu },
  { mode: 'acceptEdits', pattern: /^[^\p{L}\p{N}]{0,6}(?:auto-)?accept edits on\b/iu },
  { mode: 'auto', pattern: /^[^\p{L}\p{N}]{0,6}auto mode on\b/iu },
  // CLI 2.1.294's mode table names default "manual mode"; older builds show no text.
  { mode: 'default', pattern: /^[^\p{L}\p{N}]{0,6}manual mode on\b/iu },
];

// A selection dialog (permission prompt, plan approval, pickers) replaces the
// prompt box, and its footer is not the mode footer. Only structural markers are
// used: model prose in the transcript must not blank the reading.
const DIALOG_MARKERS: readonly RegExp[] = [
  /\besc to cancel\b/i,
  /\benter to select\b/i,
  /↑\/↓ to navigate/,
  /^\s*(?:[❯>]\s*)?\d+\.\s+(?:yes|no)\b/i,
];

const DEFAULT_FOOTER = /\?\s+for shortcuts/i;
const BOX_RULE = /^[\s╭╰╮╯│|]*[─━-]{8,}/u;
const PROMPT_ROW = /^\s*[│|]?\s*[❯>](?:\s|$)/u;

/**
 * Returns the mode the screen shows, or null when the screen is not a recognizable
 * CLI prompt (a dialog is open, the CLI is starting, or the shell is showing) so
 * the caller keeps its last reading instead of flapping.
 */
export function detectClaudeCliPermissionMode(
  screenLines: readonly string[] | null | undefined,
): ClaudeCliPermissionMode | null {
  if (!Array.isArray(screenLines)) return null;
  const nonEmpty = screenLines.map((line) => (typeof line === 'string' ? line.trimEnd() : '')).filter((l) => l.trim());
  if (nonEmpty.length === 0) return null;
  const tail = nonEmpty.slice(-TAIL_LINES);

  if (tail.some((line) => DIALOG_MARKERS.some((marker) => marker.test(line)))) return null;

  // Bottom-up: the footer is the lowest line, anything above it is older text.
  const footer = tail.slice(-FOOTER_LINES);
  for (let i = footer.length - 1; i >= 0; i -= 1) {
    const line = footer[i].trim();
    for (const { mode, pattern } of MODE_FOOTERS) {
      if (pattern.test(line)) return mode;
    }
  }

  // No mode text. That means default, but only if the screen is plainly the idle
  // prompt: the default hint, or a prompt row framed by box rules.
  if (tail.some((line) => DEFAULT_FOOTER.test(line))) return 'default';
  const hasRule = tail.some((line) => BOX_RULE.test(line));
  const hasPromptRow = tail.some((line) => PROMPT_ROW.test(line));
  return hasRule && hasPromptRow ? 'default' : null;
}
