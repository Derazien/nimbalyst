/**
 * Single source of truth for "does the host need an API key before this
 * built-in provider can run?".
 *
 * This decision used to be copy-pasted as a `switch (provider)` into every
 * path that creates a provider. When `grok-build`, `cursor-agent`, and
 * `antigravity-gemini-agent` were added, two copies were updated and the one
 * on the send hot path (`MessageStreamingHandler`) was not — so every send on
 * those providers died with "Unknown provider" at the `default:` branch, even
 * though the factory, model registry, and settings panels all knew about them.
 * `SessionData.provider` is typed `AIProviderType | string`, which widens the
 * switch to `string` and removes any compile-time exhaustiveness check.
 *
 * Callers narrow to `AIProviderType` first and call this; the `never` check in
 * `default` makes a newly-added provider a typecheck failure here instead of a
 * runtime failure in front of the user.
 *
 * Extension-agent providers never reach this function — they defer auth to
 * their own backend module and are filtered out by `resolveExtensionAgentRef`
 * / `isExtensionAgentProvider` (see providerResolution.ts).
 */

import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';

export interface ProviderAuthRequirement {
  /** The host must hold an explicitly-configured API key before sending. */
  requiresApiKey: boolean;
  /** Surfaced to the user when `requiresApiKey` and no key is configured. */
  missingKeyMessage: string;
  /**
   * Value to hand a provider that takes an apiKey argument but authenticates
   * some other way. Undefined means "pass whatever the settings store had".
   */
  placeholderApiKey?: string;
}

const NEEDS_NO_KEY: ProviderAuthRequirement = {
  requiresApiKey: false,
  missingKeyMessage: 'API key not configured',
};

/**
 * Returns null for a provider id that is not a built-in provider, so callers
 * can keep their existing "Unknown provider" error for junk persisted on a
 * session row.
 */
export function resolveProviderAuthRequirement(
  provider: AIProviderType
): ProviderAuthRequirement | null {
  switch (provider) {
    case 'claude':
      return { requiresApiKey: true, missingKeyMessage: 'Anthropic API key not configured' };
    case 'openai':
      return { requiresApiKey: true, missingKeyMessage: 'OpenAI API key not configured' };

    // Claude Code (SDK and genuine CLI) sign in through their own OAuth /
    // subscription login; a key is optional.
    case 'claude-code':
    case 'claude-code-cli':
      return NEEDS_NO_KEY;

    // Each of these authenticates through its own CLI or app login
    // (`codex auth login`, `copilot auth login`, `grok login`,
    // `cursor-agent login`, the Antigravity app). No API key, and deliberately
    // no env-var fallback -- see the standing rule in CLAUDE.md.
    case 'openai-codex':
    case 'openai-codex-acp':
    case 'opencode':
    case 'copilot-cli':
    case 'grok-build':
    case 'cursor-agent':
    case 'antigravity-gemini-agent':
      return NEEDS_NO_KEY;

    // Kimi Code (ACP and interactive CLI) signs in through `kimi login`
    // (device-code OAuth on the user's Kimi membership). No API key.
    case 'kimi-code':
    case 'kimi-code-cli':
      return NEEDS_NO_KEY;

    case 'lmstudio':
      // Needs only a base URL, but the provider signature still takes a key.
      return { ...NEEDS_NO_KEY, placeholderApiKey: 'not-required' };

    default: {
      // Compile-time exhaustiveness: adding a member to AIProviderType without
      // a case here fails `npm run typecheck` rather than the user's send.
      const unhandled: never = provider;
      void unhandled;
      return null;
    }
  }
}
