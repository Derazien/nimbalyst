/**
 * The `ClaudeCodeDeps` a headless node actually has to supply.
 *
 * Every field on `ClaudeCodeDeps` is guarded at its call site with `?.` or an
 * `if`, so a null dep is a supported state rather than a crash -- which is why
 * the list below is short. What is set here is set because leaving it null
 * changes behaviour in a way a headless run cannot recover from, not because the
 * runtime demands it. Everything else is deliberately left null:
 *
 * | Left null                      | Consequence, and why it is acceptable                    |
 * | ------------------------------ | -------------------------------------------------------- |
 * | `mcpConfigLoader`              | McpConfigService falls back to the workspace `.mcp.json`  |
 * | `mcpWithheldNamesLoader`       | Nothing is withheld; there is no OAuth check to report on |
 * | `extensionPluginsLoader`       | No extensions are installed in a headless node            |
 * | `claudeCodeSettingsLoader`     | Setting sources default to user+project+local             |
 * | `claudeSettingsEnvLoader`      | The CLI reads `~/.claude/settings.json` itself            |
 * | `shellEnvironmentLoader`       | A CLI already runs with the user's shell environment      |
 * | `enhancedPathLoader`           | Same: PATH is inherited, not reconstructed from settings  |
 * | `gitContextLoader`             | The turn gets no frozen git snapshot (#1177 is a cache    |
 * |                                | optimization, not a correctness requirement)              |
 * | `additionalDirectoriesLoader`  | No SDK-docs directory to add                              |
 * | `attachmentStagingLoader`      | The CLI takes no attachments                              |
 * | `attachmentDenyRulesLoader`    | Same                                                      |
 * | `imageCompressor`              | Same                                                      |
 * | `extensionFileTypesLoader`     | No extension-registered editors exist                     |
 * | `historyManager`               | No document history; AgentToolHooks skips snapshotting    |
 * | `claudeSettingsPatternSaver`   | "Always allow" has no UI to be clicked in                 |
 * | `claudeSettingsPatternChecker` | Same                                                      |
 */

import { ClaudeCodeProvider } from '@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider';
import { resolveClaudeBinary } from './nodeHost.js';

export interface ClaudeCodeHostOptions {
  /** Explicit `claude` executable path from the config file, if the user set one. */
  claudeCodePath?: string;
  /**
   * How the node answers a tool-permission question. A headless process has
   * nobody to ask: with no trust checker every tool call falls through to an
   * interactive prompt that will never be answered, and the turn hangs forever.
   */
  trustMode: 'allow-all' | 'bypass-all' | 'ask';
  /** Where security-relevant decisions are written. Defaults to stderr. */
  logSecurity?: (message: string, data?: unknown) => void;
}

export function registerClaudeCodeDeps(options: ClaudeCodeHostOptions): void {
  // The runtime's own binary resolution cannot work under the Node build --
  // see `resolveClaudeBinary` for why -- so the host resolves it and hands it
  // over as an explicit custom path. A configured path always wins.
  const binaryPath = options.claudeCodePath ?? resolveClaudeBinary();
  ClaudeCodeProvider.setCustomClaudeCodePathLoader(binaryPath ? () => binaryPath : null);

  // `ask` is expressible so the flag is not a lie, but it is a dead end here:
  // nothing in this process can render a prompt, so the turn will block. It is
  // the config file's problem to not choose it.
  ClaudeCodeProvider.setTrustChecker(() => ({
    trusted: true,
    mode: options.trustMode,
    // Leave the classifier off: `bypass-all` must mean literal allow-all
    // (issue #628), and the classifier's escalation path ends at a prompt.
    allowAllUsesClassifier: false,
  }));

  ClaudeCodeProvider.setSecurityLogger(
    options.logSecurity
      ?? ((message: string, data?: unknown) => {
        console.error('[security]', message, data ?? '');
      }),
  );
}
