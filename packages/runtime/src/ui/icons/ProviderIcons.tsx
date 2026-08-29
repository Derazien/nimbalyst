import React from 'react';
import { MaterialSymbol } from './MaterialSymbol';

interface IconProps {
  size?: number;
  className?: string;
}

const PROVIDER_ICON_MAP: Record<string, string> = {
  'copilot-cli': 'terminal',
  // ACP transport reuses the OpenAI Codex icon (same underlying agent).
  'openai-codex-acp': 'openai-codex',
  'claude-code-cli': 'claude-code',
  // Gemini Antigravity extension provider -> Gemini brand glyph.
  'antigravity-gemini-agent': 'gemini',
  'antigravity-gemini': 'gemini',
};

/**
 * Glyph for an extension provider that ships no `icon` in its contribution.
 * Anything is better than the fallback below, which draws the raw id.
 */
export const DEFAULT_EXTENSION_PROVIDER_ICON = 'smart_toy';

/**
 * Icons contributed by extensions, keyed on the `aiAgentProviders` contribution id.
 *
 * WHY THIS EXISTS. The fallback at the end of `resolveProviderIcon` hands the raw provider id to
 * Material Symbols as a ligature. That is right for the built-ins, whose ids ARE glyph names, and
 * wrong for every extension provider: `lea-hermes` is not a ligature, so the font draws the
 * letters and the user gets a wordmark where a 16 px icon belongs -- in the session list, on
 * every session reference chip, and in the settings sidebar. The two `antigravity-gemini*` rows
 * in the table above are that same bug, patched by hand for the one extension provider that
 * shipped before this map existed.
 *
 * `AiAgentProviderContribution.icon` already carries the right answer; until now only the model
 * picker read it, because only the picker fetches `ai:getModels`. Registering the manifest icons
 * once at extension discovery lets every surface resolve them synchronously, with no fetch.
 */
const EXTENSION_PROVIDER_ICONS = new Map<string, string>();

/**
 * Publish the icons an extension's `aiAgentProviders` contributions declare. Called from
 * extension discovery, before anything renders. Idempotent; a later call replaces an entry.
 * A provider with no declared icon still gets one, so no extension can produce a wordmark.
 */
export function registerExtensionProviderIcons(
  icons: Record<string, string | undefined>
): void {
  for (const [providerId, icon] of Object.entries(icons)) {
    if (!providerId) continue;
    EXTENSION_PROVIDER_ICONS.set(providerId, icon || DEFAULT_EXTENSION_PROVIDER_ICON);
  }
}

/** Drop an uninstalled extension's provider icons. */
export function unregisterExtensionProviderIcons(providerIds: string[]): void {
  for (const id of providerIds) EXTENSION_PROVIDER_ICONS.delete(id);
}

export function resolveProviderIcon(provider: string): string {
  return (
    PROVIDER_ICON_MAP[provider] ?? EXTENSION_PROVIDER_ICONS.get(provider) ?? provider
  );
}

/**
 * Convenience component for rendering provider icons.
 * Uses MaterialSymbol under the hood - just pass the provider name.
 */
export const ProviderIcon: React.FC<{ provider: string } & IconProps> = ({
  provider,
  size = 20,
  className = ''
}) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={size} className={className} />;
};

/**
 * Convenience function for getting a provider icon element.
 * Uses MaterialSymbol under the hood.
 */
export const getProviderIcon = (provider: string, props?: IconProps) => {
  return <MaterialSymbol icon={resolveProviderIcon(provider)} size={props?.size} className={props?.className} />;
};
