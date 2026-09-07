import { getProviderCredentials } from '../../credentials/providerCredentials';
import { safeHandle } from '../../../utils/ipcRegistry';
import type { AIServiceContext } from './AIServiceContext';

/**
 * Provider-availability probe and one-time API key initialization.
 *
 * `ai:hasApiKey` keeps its historical name for backward compatibility — it
 * answers "is any provider usable?", which for SSO-authenticated providers has
 * nothing to do with API keys.
 */
export function registerInitHandlers(ctx: AIServiceContext): void {
  // Check if any AI provider is configured with usable models
  safeHandle('ai:hasApiKey', async () => {  // Keeping the name for backward compatibility
    const apiKeys = getProviderCredentials().availableKeys();
    const providerSettings = ctx.getNormalizedProviderSettings() as any;

    // Claude Code uses its own auth (SSO) - always available if enabled
    const claudeCodeEnabled = providerSettings['claude-code']?.enabled !== false;
    if (claudeCodeEnabled) return true;

    // Claude Chat needs an Anthropic API key and enabled models
    const hasAnthropicKey = !!apiKeys['anthropic'];
    if (hasAnthropicKey) {
      const hasClaude = providerSettings['claude']?.enabled &&
                       providerSettings['claude']?.models?.length > 0;
      if (hasClaude) return true;
    }

    // Check OpenAI (needs API key and enabled models)
    const hasOpenAIKey = !!apiKeys['openai'];
    if (hasOpenAIKey) {
      const hasOpenAI = providerSettings['openai']?.enabled &&
                       providerSettings['openai']?.models?.length > 0;
      if (hasOpenAI) return true;
    }

    // Check OpenAI Codex (uses its own auth, doesn't need API key in settings)
    const hasCodex = providerSettings['openai-codex']?.enabled === true;
    if (hasCodex) return true;

    // Check LM Studio (doesn't need API key but needs enabled models)
    const hasLMStudio = providerSettings['lmstudio']?.enabled === true &&
                       providerSettings['lmstudio']?.models?.length > 0;
    if (hasLMStudio) return true;

    return false;
  });

  // Initialize/configure AI
  safeHandle('ai:initialize', async (_event, _provider?: string, apiKey?: string) => {
    if (apiKey) {
      // Save API key for the Claude Chat provider only
      // Claude Code has its own auth (SSO) and should never use this key
      getProviderCredentials().set('anthropic', apiKey);
    }

    return { success: true };
  });
}
