/**
 * Answers the genuine CLI's own "Ready to code?" plan dialog by keystroke, for projects that skip
 * permissions (no PreToolUse hook can switch the CLI to bypass there; only the dialog's option 1
 * does). Every keystroke is chosen from the screen as it is NOW and re-checked after it lands, so
 * a dialog that is not showing, or looks different, makes the driver stop and leave the answer to
 * the terminal.
 *
 * Dialog as rendered by CLI 2.1.295 (verified live, fixtures in the tests):
 *
 *    Claude has written up a plan and is ready to execute. Would you like to proceed?
 *    ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session
 *      2. Yes, manually approve edits
 *      3. Tell Claude what to change
 *         shift+tab to approve with this feedback
 *
 * Option 3 is an inline text field: once highlighted, typed text replaces its label and Enter
 * sends it as feedback. Up/Down move the highlight (proven live); number keys are not used.
 *
 * Pure and dependency-free (type-only imports) so it is unit-testable and the live harness runs
 * this very file.
 */

import type { ClaudeCliPermissionMode } from '../../../shared/claudeCliPermissionMode';

const ESC = String.fromCharCode(27);
export const PLAN_KEY_DOWN = `${ESC}[B`;
export const PLAN_KEY_UP = `${ESC}[A`;
export const PLAN_KEY_ENTER = '\r';

const QUESTION = /would you like to proceed\?/i;
const OPTION = /^\s*([❯>])?\s*(\d+)\.\s+(\S.*?)\s*$/u;
/** Option lines sit directly under the question; stop looking this far down. */
const OPTION_WINDOW = 12;

export interface PlanDialogOption {
  number: number;
  label: string;
  highlighted: boolean;
}

export interface PlanDialog {
  options: PlanDialogOption[];
  /** Index into `options` of the highlighted one, or -1 when no pointer is visible. */
  highlightedIndex: number;
  bypassIndex: number;
  keepPlanningIndex: number;
}

const BYPASS = /^yes\b.*\bbypass\b/i;
const KEEP_PLANNING = /tell claude what to change|keep planning/i;

/** The plan-approval dialog on this screen, or null when it is not (fully) showing. */
export function parsePlanApprovalDialog(lines: readonly string[] | null | undefined): PlanDialog | null {
  if (!Array.isArray(lines)) return null;
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (typeof lines[i] === 'string' && QUESTION.test(lines[i])) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  const options: PlanDialogOption[] = [];
  for (let i = q + 1; i < lines.length && i <= q + OPTION_WINDOW; i += 1) {
    const m = OPTION.exec(typeof lines[i] === 'string' ? lines[i] : '');
    if (m) options.push({ number: Number(m[2]), label: m[3], highlighted: m[1] !== undefined });
  }
  // Numbered 1..n, at least a yes and something else: anything else is not this dialog.
  if (options.length < 2 || options.some((o, i) => o.number !== i + 1) || !/^yes\b/i.test(options[0].label)) {
    return null;
  }
  const last = options.length - 1;
  let keepPlanningIndex = options.findIndex((o) => KEEP_PLANNING.test(o.label));
  // After the user types feedback the label is their text; the field is the last, non-"Yes" option.
  if (keepPlanningIndex < 0 && !/^yes\b/i.test(options[last].label)) keepPlanningIndex = last;
  return {
    options,
    highlightedIndex: options.findIndex((o) => o.highlighted),
    bypassIndex: options.findIndex((o) => BYPASS.test(o.label)),
    keepPlanningIndex,
  };
}

export type PlanDialogStep =
  | { action: 'enter' }
  | { action: 'move'; keys: string }
  | { action: 'type'; text: string }
  | { action: 'bail'; reason: string };

function moveTo(dialog: PlanDialog, target: number): PlanDialogStep {
  if (dialog.highlightedIndex < 0) return { action: 'bail', reason: 'the dialog shows no highlighted option' };
  const delta = target - dialog.highlightedIndex;
  return { action: 'move', keys: (delta > 0 ? PLAN_KEY_DOWN : PLAN_KEY_UP).repeat(Math.abs(delta)) };
}

/** Next keystroke to approve with bypass, from the current screen. */
export function planApproveStep(lines: readonly string[] | null | undefined): PlanDialogStep {
  const dialog = parsePlanApprovalDialog(lines);
  if (!dialog) return { action: 'bail', reason: 'the plan dialog is not showing' };
  if (dialog.bypassIndex < 0) return { action: 'bail', reason: 'the dialog does not offer bypass permissions' };
  if (dialog.highlightedIndex === dialog.bypassIndex) return { action: 'enter' };
  return moveTo(dialog, dialog.bypassIndex);
}

export function flattenPlanFeedback(feedback: string): string {
  return feedback.replace(/\s+/g, ' ').trim();
}

/**
 * Next keystroke to send the plan back with `feedback`. `typed` is true once the driver has typed
 * it, so the next call verifies the field shows it before Enter.
 */
export function planReviseStep(
  lines: readonly string[] | null | undefined,
  feedback: string,
  typed: boolean,
): PlanDialogStep {
  const flat = flattenPlanFeedback(feedback);
  if (!flat) return { action: 'bail', reason: 'there is no feedback to send' };
  const dialog = parsePlanApprovalDialog(lines);
  if (!dialog) return { action: 'bail', reason: 'the plan dialog is not showing' };
  if (dialog.keepPlanningIndex < 0) return { action: 'bail', reason: 'the dialog has no feedback option' };
  if (dialog.highlightedIndex !== dialog.keepPlanningIndex) return moveTo(dialog, dialog.keepPlanningIndex);
  if (!typed) return { action: 'type', text: flat };
  const label = dialog.options[dialog.keepPlanningIndex].label;
  return label.includes(flat.slice(0, 12)) ? { action: 'enter' } : { action: 'bail', reason: 'the feedback did not appear in the field' };
}

export interface PlanDriverDeps {
  /** Latest visible screen lines (the render-state model), null when unknown. */
  getLines: () => readonly string[] | null;
  write: (data: string) => void;
  delay: (ms: number) => Promise<void>;
  /** Mode the footer detector last reported. */
  readMode: () => ClaudeCliPermissionMode | null;
}

export type PlanDriveResult =
  | { ok: true; mode: ClaudeCliPermissionMode | null; confirmed: boolean }
  | { ok: false; reason: string };

const MAX_STEPS = 5;
const POLL_MS = 100;
const SETTLE_MS = 1500;
const CONFIRM_MS = 3000;

const same = (a: readonly string[] | null, b: readonly string[] | null) => JSON.stringify(a) === JSON.stringify(b);

/** Wait for the screen to differ from `before`; true if it did. */
async function waitForChange(deps: PlanDriverDeps, before: readonly string[] | null, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    await deps.delay(POLL_MS);
    if (!same(deps.getLines(), before)) return true;
  }
  return false;
}

/** Wait until the dialog is gone from the screen; true if it went. */
async function waitForDialogGone(deps: PlanDriverDeps, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    await deps.delay(POLL_MS);
    if (!parsePlanApprovalDialog(deps.getLines())) return true;
  }
  return false;
}

async function drive(
  deps: PlanDriverDeps,
  next: (typed: boolean) => PlanDialogStep,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let typed = false;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const before = deps.getLines();
    const s = next(typed);
    if (s.action === 'bail') return { ok: false, reason: s.reason };
    if (s.action === 'enter') {
      deps.write(PLAN_KEY_ENTER);
      return { ok: true };
    }
    if (s.action === 'type') {
      typed = true;
      deps.write(s.text);
    } else {
      deps.write(s.keys);
    }
    if (!(await waitForChange(deps, before, SETTLE_MS))) return { ok: false, reason: 'the dialog did not respond' };
  }
  return { ok: false, reason: 'the dialog did not settle' };
}

/**
 * Approve the plan with "switch to BYPASS PERMISSIONS" and confirm the footer says so. `ok:false`
 * means no Enter was sent (the answer belongs to the terminal); `confirmed:false` means Enter was
 * sent but the footer did not read bypass in time.
 */
export async function approvePlanOnScreen(deps: PlanDriverDeps): Promise<PlanDriveResult> {
  const sent = await drive(deps, () => planApproveStep(deps.getLines()));
  if (!sent.ok) return sent;
  await waitForDialogGone(deps, SETTLE_MS);
  let mode: ClaudeCliPermissionMode | null = deps.readMode();
  for (let waited = 0; mode !== 'bypassPermissions' && waited < CONFIRM_MS; waited += POLL_MS) {
    await deps.delay(POLL_MS);
    mode = deps.readMode();
  }
  return { ok: true, mode, confirmed: mode === 'bypassPermissions' };
}

/** Send the plan back with feedback through the dialog's inline field. */
export async function revisePlanOnScreen(deps: PlanDriverDeps, feedback: string): Promise<PlanDriveResult> {
  const sent = await drive(deps, (typed) => planReviseStep(deps.getLines(), feedback, typed));
  if (!sent.ok) return sent;
  const gone = await waitForDialogGone(deps, SETTLE_MS);
  return gone ? { ok: true, mode: deps.readMode(), confirmed: true } : { ok: false, reason: 'the dialog is still showing' };
}
