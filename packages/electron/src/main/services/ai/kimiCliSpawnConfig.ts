/**
 * The command line for the genuine `kimi` terminal app in a Kimi Code CLI
 * session. Flags as `kimi --help` 0.43.1 lists them:
 *   -S <id>          resume a kimi session (it must already exist)
 *   -m <model>       model, spelled as config.toml names it (`kimi-code/k3`)
 *   --yolo           "Ask When Needed": routine edits and commands run on their own
 *   --add-dir <dir>  another folder kimi may read
 */

import type { KimiLaunch } from '@nimbalyst/runtime/ai/server/providers/kimiLaunch';
import { scrubProviderApiKeys } from '@nimbalyst/runtime/ai/server/providerApiKeyScrub';
import type { ClaudeCliSpawnConfig } from './claudeCliSpawnConfig';

/** `kimi-code-cli:k3`, `kimi-code:k3`, `k3` or `kimi-code/k3` -> `kimi-code/k3`. */
export function kimiCliModelArg(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  if (model.startsWith('kimi-code/')) return model;
  const colon = model.indexOf(':');
  if (colon !== -1) {
    const provider = model.slice(0, colon);
    if (provider !== 'kimi-code-cli' && provider !== 'kimi-code') return undefined;
    model = model.slice(colon + 1);
  }
  return model ? `kimi-code/${model}` : undefined;
}

export interface KimiCliSpawnInput {
  launch: KimiLaunch;
  /** The environment kimi inherits (shell env plus the enhanced PATH). */
  baseEnv: Record<string, string | undefined>;
  model?: string | null;
  resumeKimiSessionId?: string;
  yolo?: boolean;
  additionalDirectories?: string[];
}

export function buildKimiCliSpawnConfig(input: KimiCliSpawnInput): ClaudeCliSpawnConfig {
  const args = [...input.launch.prefixArgs];
  if (input.resumeKimiSessionId) args.push('-S', input.resumeKimiSessionId);
  const model = kimiCliModelArg(input.model);
  if (model) args.push('-m', model);
  if (input.yolo) args.push('--yolo');
  for (const dir of input.additionalDirectories ?? []) args.push('--add-dir', dir);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...input.baseEnv, ...input.launch.env })) {
    if (value !== undefined) env[key] = value;
  }
  // kimi signs in with `kimi login`; an API key in the environment must never
  // reach it and bill another account.
  return { executable: input.launch.command, args, env: scrubProviderApiKeys(env) };
}
