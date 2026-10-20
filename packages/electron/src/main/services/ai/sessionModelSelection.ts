import {
  ModelIdentifier,
  type AIProviderType,
} from '@nimbalyst/runtime/ai/server/types';

export interface SessionModelSelection {
  provider: AIProviderType;
  model: string;
}

/**
 * Keep the persisted session provider aligned with a provider-qualified model.
 * The model is authoritative when it carries a valid provider prefix; otherwise
 * the requested provider is preserved for legacy/raw model selections.
 */
export function resolveSessionModelSelection(
  requestedProvider: AIProviderType,
  requestedModel?: string | null,
): SessionModelSelection {
  if (!requestedModel) {
    return {
      provider: requestedProvider,
      model: ModelIdentifier.getDefaultModelId(requestedProvider),
    };
  }

  const parsedModel = ModelIdentifier.tryParse(requestedModel);
  return {
    provider: parsedModel?.provider ?? requestedProvider,
    model: requestedModel,
  };
}

/**
 * Selection for a creator that may have been given neither a provider nor a
 * model (mobile requests, child sessions, voice). The user's default model
 * decides the provider; `claude-code` is only the last resort when no default
 * is stored, and the session-store guard still vets it against Settings.
 *
 * Do not pass a literal `'claude-code'` as the requested provider: that is how
 * sessions kept landing on the Claude Agent provider after it was disabled and
 * the user's default model pointed at the CLI.
 */
export function resolveSelectionWithDefault(input: {
  provider?: string | null;
  model?: string | null;
  defaultModel?: string | null;
}): SessionModelSelection {
  const { provider, model, defaultModel } = input;
  if (model) {
    return resolveSessionModelSelection(
      (provider || ModelIdentifier.tryParse(model)?.provider || 'claude-code') as AIProviderType,
      model,
    );
  }
  if (provider) return resolveSessionModelSelection(provider as AIProviderType);
  const parsedDefault = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
  if (parsedDefault && defaultModel) {
    return { provider: parsedDefault.provider, model: defaultModel };
  }
  return resolveSessionModelSelection('claude-code');
}
