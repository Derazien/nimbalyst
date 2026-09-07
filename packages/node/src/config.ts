/**
 * Configuration for a headless Nimbalyst node.
 *
 * Every value comes from a config file whose path the caller states. Nothing is
 * read from `process.env`, and credentials especially are not: a user with an
 * unrelated `ANTHROPIC_API_KEY` in a `.env` had it silently picked up,
 * auto-persisted and billed against their personal account. See the
 * "Never Use Environment Variables as Implicit API Key Sources" rule in
 * CLAUDE.md. There is no fallback here on purpose -- an absent key means the
 * provider runs on the `claude` CLI's own login, which is the correct headless
 * default.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface NodeConfig {
  /**
   * Where `nimbalyst.sqlite` lives. Relative paths resolve against the config
   * file's own directory so a config file is portable with its data.
   */
  databasePath: string;

  /**
   * Directory holding the numbered schema migrations. Defaults to the copy
   * inside `packages/electron`, which is the only place they exist today --
   * see `resolveSchemaDir` for why that is a finding and not a design.
   */
  schemaDir?: string;

  /**
   * Absolute path to the `claude` executable. When absent the node resolves the
   * Claude Agent SDK's bundled native binary itself; see `nodeHost.ts`.
   */
  claudeCodePath?: string;

  /**
   * Explicitly-provisioned provider credentials, keyed by provider id. Only
   * ever read from this file. `claude-code` does not need one -- it authenticates
   * through the CLI's own login -- so this exists for the providers that do.
   */
  providerApiKeys?: Record<string, string>;

  /**
   * Workspace trust. A headless node has no user to ask, so the trust answer has
   * to be stated up front rather than defaulted: without it every tool call
   * blocks on a permission prompt nobody will ever answer.
   */
  trust?: {
    mode: 'allow-all' | 'bypass-all' | 'ask';
  };
}

export interface LoadedConfig extends NodeConfig {
  /** Absolute path the config was read from. */
  configPath: string;
  /** `databasePath` resolved to absolute. */
  resolvedDatabasePath: string;
}

function fail(message: string): never {
  throw new Error(`[nimbalyst-node] ${message}`);
}

export function loadConfig(configPath: string): LoadedConfig {
  const absoluteConfigPath = path.resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absoluteConfigPath, 'utf-8');
  } catch (error) {
    fail(
      `could not read config file at ${absoluteConfigPath}. `
      + `Configuration, including any credentials, must come from a file you provisioned: `
      + `${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`config file ${absoluteConfigPath} is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`config file ${absoluteConfigPath} must contain a JSON object`);
  }

  const config = parsed as Partial<NodeConfig>;
  if (typeof config.databasePath !== 'string' || config.databasePath.length === 0) {
    fail(`config file ${absoluteConfigPath} must set "databasePath"`);
  }

  const configDir = path.dirname(absoluteConfigPath);

  return {
    ...config,
    databasePath: config.databasePath,
    resolvedDatabasePath: path.resolve(configDir, config.databasePath),
    schemaDir: config.schemaDir ? path.resolve(configDir, config.schemaDir) : undefined,
    configPath: absoluteConfigPath,
  };
}
