/**
 * Put Nimbalyst's effort selection onto a running Kimi Code CLI session.
 *
 * kimi has no launch flag for its thinking effort. KIMI_MODEL_THINKING_EFFORT
 * exists, but it forces the value for the whole process and then outranks every
 * later change (`effective: forced ?? base` in kimi), which would make the
 * selector useless mid-session. So this types into the terminal, like the model
 * switch beside it.
 *
 * Verified on kimi 2.0.2: `/effort <level>` applies the level AND writes it to
 * config.toml as the global default. `/effort` on its own opens a picker
 * (`Low  [ High ]  Max`) where Left and Right move, Enter also persists, and
 * Alt+S takes the level for this session only. kimi then prints "Thinking set
 * to max for this session only." and its status line reads `thinking: max`,
 * which is the confirmation. It works before the first prompt too, when kimi
 * has no session and no event log yet.
 */

import { clampEffortLevel, parseEffortLevel, resolveKimiEffortLevels } from '@nimbalyst/runtime/ai/server/effortLevels';

const STEP_GAP_MS = 150;
const KEY_GAP_MS = 60;
const POLL_MS = 100;
const PICKER_POLLS = 30;
const CONFIRM_POLLS = 30;

export interface SwitchKimiCliEffortDeps {
  write: (data: string) => void;
  delay: (ms: number) => Promise<void>;
  /** The effort kimi last showed or logged (`thinking: max`), if any. */
  currentEffort: () => string | null;
  /** The levels in kimi's open effort picker, left to right, or null while it is not up. */
  pickerLevels: () => string[] | null;
}

export type SwitchKimiCliEffortResult = { switched: true; effort: string } | { switched: false };

export async function switchKimiCliEffort(
  input: { effort: string; model?: string | null },
  deps: SwitchKimiCliEffortDeps,
): Promise<SwitchKimiCliEffortResult> {
  // No levels to choose from: the composer shows no selector for it either.
  if (!resolveKimiEffortLevels(input.model ?? undefined)?.length) return { switched: false };
  const effort = clampEffortLevel(parseEffortLevel(input.effort), input.model ?? undefined);
  if (deps.currentEffort() === effort) return { switched: true, effort };

  // `/` opens the command menu as a keystroke; the space closes its
  // autocomplete so Enter runs the literal command.
  deps.write('/');
  await deps.delay(STEP_GAP_MS);
  deps.write('effort');
  await deps.delay(STEP_GAP_MS);
  deps.write(' ');
  await deps.delay(STEP_GAP_MS);
  deps.write('\r');

  let levels: string[] | null = null;
  for (let i = 0; i < PICKER_POLLS && !levels; i++) {
    await deps.delay(POLL_MS);
    levels = deps.pickerLevels();
  }
  // The picker is read rather than assumed, so a model whose levels changed
  // upstream is never walked to the wrong one.
  const target = levels?.indexOf(effort) ?? -1;
  if (!levels || target === -1) {
    deps.write('\x1b');
    return { switched: false };
  }

  // Left stops at the first level, so this lands on it wherever the picker opened.
  for (let i = 0; i < levels.length; i++) {
    deps.write('\x1b[D');
    await deps.delay(KEY_GAP_MS);
  }
  for (let i = 0; i < target; i++) {
    deps.write('\x1b[C');
    await deps.delay(KEY_GAP_MS);
  }
  deps.write('\x1bs');

  for (let i = 0; i < CONFIRM_POLLS; i++) {
    if (deps.currentEffort() === effort) return { switched: true, effort };
    await deps.delay(POLL_MS);
  }
  // Leave kimi at its prompt rather than in an open picker.
  deps.write('\x1b');
  return { switched: false };
}
