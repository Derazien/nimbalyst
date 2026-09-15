// @vitest-environment node
/**
 * Guards the bug where `grok-build` and `cursor-agent` were wired into the
 * provider factory, model registry, and settings panels but missed by the
 * auth switch on the send path, so every send died with "Unknown provider".
 * `SessionData.provider` is `AIProviderType | string`, so TypeScript could not
 * catch the omission at the call site — this test covers what the cast hides.
 */

import { describe, it, expect } from 'vitest';
import { AI_PROVIDER_TYPES } from '@nimbalyst/runtime/ai/server/types';
import { resolveProviderAuthRequirement } from '../providerAuthRequirement';

describe('resolveProviderAuthRequirement', () => {
  it('resolves every built-in provider type', () => {
    const unresolved = AI_PROVIDER_TYPES.filter(
      (provider) => resolveProviderAuthRequirement(provider) === null
    );
    expect(unresolved).toEqual([]);
  });

  it('does not require a host API key for CLI-login agents', () => {
    for (const provider of ['grok-build', 'cursor-agent', 'antigravity-gemini-agent', 'kimi-code', 'kimi-code-cli'] as const) {
      expect(resolveProviderAuthRequirement(provider)?.requiresApiKey).toBe(false);
    }
  });

  it('still requires a key for the direct-API providers', () => {
    expect(resolveProviderAuthRequirement('claude')?.requiresApiKey).toBe(true);
    expect(resolveProviderAuthRequirement('openai')?.requiresApiKey).toBe(true);
  });

  it('returns null for a provider id that is not built in', () => {
    expect(resolveProviderAuthRequirement('not-a-provider' as never)).toBeNull();
  });
});
