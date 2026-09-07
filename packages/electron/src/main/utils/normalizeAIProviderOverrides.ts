import type { AIProviderOverrides } from "./store";
import { normalizeCodexProviderConfig } from "@nimbalyst/runtime/ai/server/utils/modelConfigUtils";

export function normalizeAIProviderOverrides(
  overrides: AIProviderOverrides | undefined
): AIProviderOverrides | undefined {
  if (!overrides || typeof overrides !== "object") {
    return overrides;
  }

  const providers = overrides.providers;
  if (!providers || typeof providers !== "object") {
    return overrides;
  }

  const normalizedProviders = normalizeCodexProviderConfig(providers);
  const codexConfig = normalizedProviders["openai-codex"];

  // Drop an empty codex config entry (artifact of UI clearing the override).
  if (codexConfig && Object.keys(codexConfig).length === 0) {
    const { "openai-codex": _removed, ...restProviders } = normalizedProviders;
    if (Object.keys(restProviders).length === 0) {
      const { providers: _unusedProviders, ...restOverrides } = overrides;
      // Spreading the input keeps own-but-undefined keys (e.g. an explicit
      // `customClaudeCodePath: undefined` from a "clear override" save), which
      // would prevent the empty-overrides check below from collapsing the
      // object back to `undefined`.
      if (restOverrides.customClaudeCodePath === undefined) {
        delete restOverrides.customClaudeCodePath;
      }
      return Object.keys(restOverrides).length > 0 ? restOverrides : undefined;
    }
    return { ...overrides, providers: restProviders };
  }

  return {
    ...overrides,
    providers: normalizedProviders,
  };
}
