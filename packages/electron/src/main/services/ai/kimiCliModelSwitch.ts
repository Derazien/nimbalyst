/**
 * Switch a running Kimi Code CLI session's model without restarting kimi.
 *
 * Verified on kimi 0.43.1: `/model <name>` does not switch by itself, it opens
 * kimi's model picker with that model preselected. In the picker Enter would
 * also change kimi's global default (config.toml); Alt+S takes the model for
 * this session only and leaves config.toml alone. kimi then writes
 * `config.update {modelAlias}` to the event log, which is the confirmation.
 */

import { kimiCliModelArg } from './kimiCliSpawnConfig';

const STEP_GAP_MS = 150;
const PICKER_OPEN_MS = 800;
const CONFIRM_POLL_MS = 100;
const CONFIRM_POLLS = 30;

export interface SwitchKimiCliModelDeps {
  write: (data: string) => void;
  delay: (ms: number) => Promise<void>;
  /** The model the session's event log last reported. */
  currentModel: () => string | null;
}

export type SwitchKimiCliModelResult = { switched: true; cliArg: string } | { switched: false };

export async function switchKimiCliModel(
  input: { model: string },
  deps: SwitchKimiCliModelDeps,
): Promise<SwitchKimiCliModelResult> {
  const cliArg = kimiCliModelArg(input.model);
  if (!cliArg) return { switched: false };
  if (deps.currentModel() === cliArg) return { switched: true, cliArg };

  // `/` opens the command menu as a keystroke; the space closes its
  // autocomplete so Enter runs the literal command.
  deps.write('/');
  await deps.delay(STEP_GAP_MS);
  deps.write(`model ${cliArg}`);
  await deps.delay(STEP_GAP_MS);
  deps.write(' ');
  await deps.delay(STEP_GAP_MS);
  deps.write('\r');
  await deps.delay(PICKER_OPEN_MS);
  deps.write('\x1bs');

  for (let i = 0; i < CONFIRM_POLLS; i++) {
    if (deps.currentModel() === cliArg) return { switched: true, cliArg };
    await deps.delay(CONFIRM_POLL_MS);
  }
  // Leave kimi at its prompt rather than in an open picker.
  deps.write('\x1b');
  return { switched: false };
}
