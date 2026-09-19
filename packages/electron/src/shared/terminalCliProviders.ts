/**
 * Providers whose turns run in the genuine vendor CLI inside a Nimbalyst
 * terminal (no in-process turn driver): prompts go to the PTY, Stop is Ctrl-C,
 * and the queue drains when the CLI reports idle.
 */
export const TERMINAL_CLI_PROVIDERS = ['claude-code-cli', 'kimi-code-cli'] as const;

export function isTerminalCliProvider(provider: string | null | undefined): boolean {
  return provider === 'claude-code-cli' || provider === 'kimi-code-cli';
}
