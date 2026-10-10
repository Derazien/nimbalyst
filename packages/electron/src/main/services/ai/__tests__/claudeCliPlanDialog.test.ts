// @vitest-environment node
/**
 * Keystrokes into the CLI's own plan dialog, chosen from the screen. The fixtures are the bottom
 * of the real dialog, captured from claude 2.1.295 through a VT screen model (the plan body above
 * it has its own "1." line, which must not be mistaken for an option).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  approvePlanManualOnScreen,
  approvePlanOnScreen,
  parsePlanApprovalDialog,
  planApproveStep,
  planManualStep,
  planReviseStep,
  revisePlanOnScreen,
  PLAN_KEY_DOWN,
  PLAN_KEY_ENTER,
  PLAN_KEY_UP,
  type PlanDriverDeps,
} from '../claudeCliPlanDialog';
import { detectClaudeCliPermissionMode } from '../claudeCliModeDetector';

const PLAN_BODY = [
  '   Plan: create hello.txt',
  '   Step',
  '   1. Write hello.txt in the project directory with the content hi.',
  '   Verification',
  '   Read hello.txt and confirm it contains hi.',
  '  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  ────────────────────────────────────────',
  '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
];
const HINTS = [
  '        shift+tab to approve with this feedback',
  '   ctrl+g to edit in Notepad · ~\\.claude\\plans\\plan-how-to-create-glimmering-flame.md',
];
const OPT1 = '   ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session';
const OPT2 = '     2. Yes, manually approve edits';
const OPT3 = '     3. Tell Claude what to change';
const dialog = (o1: string, o2: string, o3: string) => [...PLAN_BODY, o1, o2, o3, ...HINTS];

const OPT1_PLAIN = OPT1.replace('❯ ', '  ');
const AT_BYPASS = dialog(OPT1, OPT2, OPT3);
const AT_MANUAL = dialog(OPT1_PLAIN, OPT2.replace('     2.', '   ❯ 2.'), OPT3);
const AT_FEEDBACK = dialog(OPT1_PLAIN, OPT2, OPT3.replace('     3.', '   ❯ 3.'));
const AT_FEEDBACK_TYPED = dialog(OPT1_PLAIN, OPT2, '   ❯ 3. use the file name hi.txt instead');

const FOOTER_BYPASS = [
  '',
  '  ────────────────────────────────────────',
  '❯',
  '  ────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents',
];
const FOOTER_PLAN = [...FOOTER_BYPASS.slice(0, 4), '  ⏸ plan mode on (shift+tab to cycle) · esc to interrupt · ← for agents'];

describe('parsePlanApprovalDialog', () => {
  it('finds the three options, the highlight and the bypass / feedback targets on the real dialog', () => {
    const d = parsePlanApprovalDialog(AT_BYPASS)!;
    expect(d.options.map((o) => o.number)).toEqual([1, 2, 3]);
    expect([d.highlightedIndex, d.bypassIndex, d.keepPlanningIndex]).toEqual([0, 0, 2]);
    expect(parsePlanApprovalDialog(AT_MANUAL)!.highlightedIndex).toBe(1);
    // The inline feedback field shows the user's text instead of the label; it is still the field.
    const typed = parsePlanApprovalDialog(AT_FEEDBACK_TYPED)!;
    expect([typed.highlightedIndex, typed.keepPlanningIndex]).toEqual([2, 2]);
  });

  it('is null when no dialog is showing, however much plan-like text is on screen', () => {
    expect(parsePlanApprovalDialog(PLAN_BODY.slice(0, 7))).toBeNull();
    expect(parsePlanApprovalDialog(FOOTER_BYPASS)).toBeNull();
    expect(parsePlanApprovalDialog(['Would you like to proceed?', 'sure, 1. Yes maybe'])).toBeNull();
    expect(parsePlanApprovalDialog(null)).toBeNull();
    // A generic permission prompt has Yes/No options but not this question.
    expect(parsePlanApprovalDialog(['Do you want to create hello.txt?', '❯ 1. Yes', '  2. No'])).toBeNull();
  });
});

describe('planApproveStep', () => {
  it('presses Enter only when option 1 is the highlighted bypass option', () => {
    expect(planApproveStep(AT_BYPASS)).toEqual({ action: 'enter' });
  });

  it('moves the highlight to the bypass option first (no Enter on another option)', () => {
    expect(planApproveStep(AT_MANUAL)).toEqual({ action: 'move', keys: PLAN_KEY_UP });
    expect(planApproveStep(AT_FEEDBACK)).toEqual({ action: 'move', keys: PLAN_KEY_UP.repeat(2) });
  });

  it('sends nothing when the dialog is absent or offers no bypass', () => {
    expect(planApproveStep(FOOTER_BYPASS)).toMatchObject({ action: 'bail' });
    const noBypass = dialog('   ❯ 1. Yes, and auto-accept edits', OPT2, OPT3);
    expect(planApproveStep(noBypass)).toMatchObject({ action: 'bail', reason: expect.stringContaining('bypass') });
    const noPointer = dialog(OPT1_PLAIN, OPT2, OPT3);
    expect(planApproveStep(noPointer)).toMatchObject({ action: 'bail' });
  });
});

describe('planManualStep', () => {
  it('finds option 2 on the real dialog and moves to it with Down from the bypass option, Enter once there', () => {
    expect(parsePlanApprovalDialog(AT_BYPASS)!.manualIndex).toBe(1);
    expect(planManualStep(AT_BYPASS)).toEqual({ action: 'move', keys: PLAN_KEY_DOWN });
    expect(planManualStep(AT_MANUAL)).toEqual({ action: 'enter' });
    expect(planManualStep(AT_FEEDBACK)).toEqual({ action: 'move', keys: PLAN_KEY_UP });
  });

  it('sends nothing when the dialog is absent, shows no pointer, or option 2 is not the manual one', () => {
    expect(planManualStep(FOOTER_BYPASS)).toMatchObject({ action: 'bail', reason: 'the plan dialog is not showing' });
    expect(planManualStep(null)).toMatchObject({ action: 'bail' });
    expect(planManualStep(dialog(OPT1_PLAIN, OPT2, OPT3))).toMatchObject({ action: 'bail' });
    // A future CLI that reorders or renames the options must not get an Enter on whatever is at index 1.
    const renamed = dialog(OPT1, '     2. Yes, and auto-accept edits', OPT3);
    expect(planManualStep(renamed)).toMatchObject({ action: 'bail', reason: expect.stringContaining('manual') });
  });
});

describe('planReviseStep', () => {
  it('walks to the feedback field, types the flattened text, checks it shows, then submits', () => {
    expect(planReviseStep(AT_BYPASS, 'a\nb', false)).toEqual({ action: 'move', keys: PLAN_KEY_DOWN.repeat(2) });
    expect(planReviseStep(AT_FEEDBACK, ' use the file name\n hi.txt  instead ', false)).toEqual({
      action: 'type',
      text: 'use the file name hi.txt instead',
    });
    expect(planReviseStep(AT_FEEDBACK_TYPED, 'use the file name hi.txt instead', true)).toEqual({ action: 'enter' });
  });

  it('does not submit text the field never showed, and ignores empty feedback or a missing dialog', () => {
    expect(planReviseStep(AT_FEEDBACK, 'use the file name hi.txt instead', true)).toMatchObject({ action: 'bail' });
    expect(planReviseStep(AT_FEEDBACK, '  \n ', false)).toMatchObject({ action: 'bail' });
    expect(planReviseStep(FOOTER_PLAN, 'x', false)).toMatchObject({ action: 'bail' });
  });
});

/** A scripted CLI: each write moves the screen to the next frame. */
function scripted(frames: string[][], modeFrames?: (screen: string[]) => ReturnType<typeof detectClaudeCliPermissionMode>) {
  let i = 0;
  const writes: string[] = [];
  const deps: PlanDriverDeps = {
    getLines: () => frames[Math.min(i, frames.length - 1)],
    write: vi.fn((d: string) => {
      writes.push(d);
      i += 1;
    }),
    delay: async () => {},
    readMode: () => (modeFrames ?? detectClaudeCliPermissionMode)(frames[Math.min(i, frames.length - 1)]),
  };
  return { deps, writes };
}

describe('approvePlanOnScreen', () => {
  it('Enter on the highlighted bypass option, then confirms bypass from the footer', async () => {
    const { deps, writes } = scripted([AT_BYPASS, FOOTER_BYPASS]);
    await expect(approvePlanOnScreen(deps)).resolves.toEqual({ ok: true, mode: 'bypassPermissions', confirmed: true });
    expect(writes).toEqual([PLAN_KEY_ENTER]);
  });

  it('moves up then presses Enter when another option was highlighted (the live B2 sequence)', async () => {
    const { deps, writes } = scripted([AT_MANUAL, AT_BYPASS, FOOTER_BYPASS]);
    const result = await approvePlanOnScreen(deps);
    expect(writes).toEqual([PLAN_KEY_UP, PLAN_KEY_ENTER]);
    expect(result).toMatchObject({ ok: true, confirmed: true });
  });

  it('writes nothing when the dialog is not showing', async () => {
    const { deps, writes } = scripted([FOOTER_PLAN]);
    await expect(approvePlanOnScreen(deps)).resolves.toEqual({ ok: false, reason: 'the plan dialog is not showing' });
    expect(writes).toEqual([]);
  });

  it('stops without Enter when the dialog ignores the move', async () => {
    const { deps, writes } = scripted([AT_MANUAL]);
    const result = await approvePlanOnScreen(deps);
    expect(result).toMatchObject({ ok: false });
    expect(writes).toEqual([PLAN_KEY_UP]);
  });

  it('reports Enter sent but bypass unconfirmed when the footer never says so', async () => {
    const { deps } = scripted([AT_BYPASS, FOOTER_PLAN]);
    await expect(approvePlanOnScreen(deps)).resolves.toMatchObject({ ok: true, mode: 'plan', confirmed: false });
  });
});

describe('approvePlanManualOnScreen', () => {
  const FOOTER_MANUAL = [...FOOTER_BYPASS.slice(0, 4), '  ? for shortcuts'];

  it('Down then Enter from the default highlight, then confirms the footer reads the default mode', async () => {
    const { deps, writes } = scripted([AT_BYPASS, AT_MANUAL, FOOTER_MANUAL]);
    await expect(approvePlanManualOnScreen(deps)).resolves.toEqual({ ok: true, mode: 'default', confirmed: true });
    expect(writes).toEqual([PLAN_KEY_DOWN, PLAN_KEY_ENTER]);
  });

  it('writes no keystroke when the dialog is not showing', async () => {
    const { deps, writes } = scripted([FOOTER_PLAN]);
    await expect(approvePlanManualOnScreen(deps)).resolves.toEqual({ ok: false, reason: 'the plan dialog is not showing' });
    expect(writes).toEqual([]);
  });

  it('reports Enter sent but unconfirmed when the footer still reads bypass', async () => {
    const { deps } = scripted([AT_MANUAL, FOOTER_BYPASS]);
    await expect(approvePlanManualOnScreen(deps)).resolves.toMatchObject({ ok: true, mode: 'bypassPermissions', confirmed: false });
  });
});

describe('revisePlanOnScreen', () => {
  it('selects the field, types the feedback, submits, and waits for the dialog to leave', async () => {
    const { deps, writes } = scripted([AT_BYPASS, AT_FEEDBACK, AT_FEEDBACK_TYPED, FOOTER_PLAN]);
    const result = await revisePlanOnScreen(deps, 'use the file name hi.txt instead');
    expect(writes).toEqual([PLAN_KEY_DOWN.repeat(2), 'use the file name hi.txt instead', PLAN_KEY_ENTER]);
    expect(result).toMatchObject({ ok: true });
  });

  it('flattens newlines into single spaces before typing', async () => {
    const { deps, writes } = scripted([AT_FEEDBACK, dialog(OPT1_PLAIN, OPT2, '   ❯ 3. shorter please')]);
    await revisePlanOnScreen(deps, 'shorter\n\nplease').catch(() => {});
    expect(writes[0]).toBe('shorter please');
  });
});
