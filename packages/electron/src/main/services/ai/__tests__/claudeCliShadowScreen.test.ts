// @vitest-environment node
/**
 * Main's own screen for a claude-code-cli terminal, built from raw PTY bytes. The bytes below draw
 * the bottom of the real 2.1.295 plan dialog the way a TUI does (clear, cursor moves, colors), so
 * what the plan driver and the mode chip read is exactly what a collapsed drawer would hide from
 * the renderer.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliShadowScreen } from '../claudeCliShadowScreen';
import { parsePlanApprovalDialog, planApproveStep, planManualStep, PLAN_KEY_UP } from '../claudeCliPlanDialog';
import { detectClaudeCliPermissionMode } from '../claudeCliModeDetector';

const ESC = '\x1b';
const at = (row: number, text: string) => `${ESC}[${row};1H${ESC}[2K${text}`;
const DIM = (t: string) => `${ESC}[2m${t}${ESC}[0m`;

const OPTIONS = [
  'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
  'Yes, manually approve edits',
  'Tell Claude what to change',
];

/** A full repaint of the dialog with the pointer on option `highlighted` (1-based), then the footer. */
function paintDialog(highlighted: number): string {
  const rows = [
    at(1, `${ESC}[1m   Plan: create hello.txt${ESC}[22m`),
    at(2, '   1. Write hello.txt in the project directory with the content hi.'),
    at(3, DIM('  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌')),
    at(4, '   Claude has written up a plan and is ready to execute. Would you like to proceed?'),
    ...OPTIONS.map((label, i) =>
      at(5 + i, i + 1 === highlighted ? `   ${ESC}[38;5;105m❯ ${i + 1}. ${label}${ESC}[39m` : `     ${i + 1}. ${label}`)
    ),
    at(9, DIM('        shift+tab to approve with this feedback')),
    at(20, '  ────────────────────────────────────────'),
    at(21, '❯'),
    at(22, '  ────────────────────────────────────────'),
    at(23, `  ${ESC}[38;5;211m⏸ plan mode on${ESC}[39m (shift+tab to cycle) · esc to interrupt · ← for agents`),
  ];
  return `${ESC}[2J${rows.join('')}`;
}

describe('ClaudeCliShadowScreen', () => {
  it('reads the plan dialog and the mode footer off raw PTY bytes, follows the pointer, and survives a resize', () => {
    const shadow = new ClaudeCliShadowScreen(100, 24);
    expect(shadow.live).toBe(true);

    // Bytes arrive split mid escape sequence, as PTY chunks do.
    const bytes = paintDialog(1);
    shadow.write(bytes.slice(0, 57));
    shadow.write(bytes.slice(57));

    const lines = shadow.lines()!;
    expect(lines).toHaveLength(24);
    const dialog = parsePlanApprovalDialog(lines)!;
    expect([dialog.bypassIndex, dialog.manualIndex, dialog.keepPlanningIndex, dialog.highlightedIndex]).toEqual([0, 1, 2, 0]);
    expect(planApproveStep(lines)).toEqual({ action: 'enter' });
    // A dialog replaces the prompt box, so the mode footer under it is deliberately not read.
    expect(detectClaudeCliPermissionMode(lines)).toBeNull();

    shadow.write(paintDialog(2));
    expect(planApproveStep(shadow.lines())).toEqual({ action: 'move', keys: PLAN_KEY_UP });
    expect(planManualStep(shadow.lines())).toEqual({ action: 'enter' });

    // A taller, wider terminal keeps the content (the CLI repaints after SIGWINCH) and stays usable.
    shadow.resize(120, 30);
    expect(shadow.lines()).toHaveLength(30);
    shadow.write(paintDialog(1));
    expect(planApproveStep(shadow.lines())).toEqual({ action: 'enter' });

    // Dialog answered: the idle prompt and its footer repaint, and the chip can follow.
    shadow.write(`${ESC}[2J${at(20, '  ────────────────────────────────────────')}${at(21, '❯')}${at(22, '  ────────────────────────────────────────')}${at(23, `  ${ESC}[38;5;211m⏵⏵ bypass permissions on${ESC}[39m (shift+tab to cycle)`)}`);
    expect(detectClaudeCliPermissionMode(shadow.lines())).toBe('bypassPermissions');
  });

  it('keeps wide characters as one glyph and blank cells as spaces', () => {
    const shadow = new ClaudeCliShadowScreen(10, 2);
    shadow.write('a中b\r\n❯ x');
    expect(shadow.lines()).toEqual(['a中b      ', '❯ x       ']);
  });

  it('turns itself off, without throwing, when the wasm cannot be loaded or after dispose', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = new ClaudeCliShadowScreen(80, 24, ['/no/such/ghostty-vt.wasm']);
    expect(missing.live).toBe(false);
    expect(() => { missing.write('x'); missing.resize(90, 30); }).not.toThrow();
    expect(missing.lines()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    const shadow = new ClaudeCliShadowScreen(80, 24);
    shadow.dispose();
    expect(shadow.live).toBe(false);
    expect(shadow.lines()).toBeNull();
    warn.mockRestore();
  });
});
