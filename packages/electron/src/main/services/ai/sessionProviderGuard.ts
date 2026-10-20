import { ModelIdentifier, type AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import type { CreateSessionPayload, SessionStore } from '@nimbalyst/runtime';

/**
 * Choke-point guard: a session is never persisted with a provider the user has
 * disabled in Settings, whichever code path asked for it.
 *
 * Many creators (renderer IPC, meta-agent spawn, mobile requests, voice,
 * automations, extensions) pick their own provider and a few of them fall back
 * to a hardcoded `claude-code`. Fixing each one is necessary but not sufficient,
 * so every create also goes through this guard, which reads the REAL enabled
 * state from the main-process settings (never a renderer copy).
 *
 * The module is pure: the settings reads are injected, see
 * `sessionProviderGuardSettings.ts` for the live wiring.
 */

export interface SessionProviderGuardSettings {
  /** Effective enabled state: global toggle plus any project override. */
  isProviderEnabled(provider: string, workspacePath?: string): boolean;
  /** The user's default model for new sessions (`defaultAIModel`), if set. */
  getDefaultModel(): string | undefined;
  /** An explicitly stored default provider, if the user ever set one. */
  getDefaultProvider(): string | undefined;
  /** Extension-contributed agent providers have their own enablement. */
  isExtensionProvider(provider: string): boolean;
  log(message: string): void;
}

export interface ProviderSelection {
  provider: string;
  model: string | undefined;
}

export class ProviderDisabledError extends Error {
  constructor(public readonly provider: string) {
    super(
      `Provider "${provider}" is disabled in Settings and no enabled default provider is configured. ` +
      'Enable a provider in Settings > AI, or set a default model, then try again.'
    );
    this.name = 'ProviderDisabledError';
  }
}

/**
 * The user's configured default as a concrete selection, or null when the
 * configured default is itself missing or disabled.
 */
export function resolveEnabledDefaultSelection(
  settings: SessionProviderGuardSettings,
  workspacePath?: string,
): ProviderSelection | null {
  const defaultModel = settings.getDefaultModel();
  const parsed = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
  if (parsed && settings.isProviderEnabled(parsed.provider, workspacePath)) {
    return { provider: parsed.provider, model: defaultModel };
  }

  const defaultProvider = settings.getDefaultProvider();
  if (defaultProvider && settings.isProviderEnabled(defaultProvider, workspacePath)) {
    return {
      provider: defaultProvider,
      model: ModelIdentifier.getDefaultModelId(defaultProvider as AIProviderType),
    };
  }
  return null;
}

/**
 * Resolve a requested provider/model to one that is enabled. Returns the input
 * unchanged when it is already enabled. Throws ProviderDisabledError when it is
 * disabled and there is no enabled default to fall back to.
 */
export function resolveEnabledSelection(
  requested: { provider: string; model?: string | null; workspacePath?: string },
  settings: SessionProviderGuardSettings,
): ProviderSelection & { redirected: boolean } {
  const { provider, workspacePath } = requested;
  const model = requested.model ?? undefined;
  if (!provider || settings.isExtensionProvider(provider) || settings.isProviderEnabled(provider, workspacePath)) {
    return { provider, model, redirected: false };
  }

  // The model is authoritative when it names a different, enabled provider
  // (e.g. a hardcoded provider next to a `claude-code-cli:*` default model).
  const modelProvider = model ? ModelIdentifier.tryParse(model)?.provider : undefined;
  if (modelProvider && modelProvider !== provider && settings.isProviderEnabled(modelProvider, workspacePath)) {
    settings.log(`[provider-guard] requested ${provider} is disabled, using ${modelProvider} (model ${model})`);
    return { provider: modelProvider, model, redirected: true };
  }

  const fallback = resolveEnabledDefaultSelection(settings, workspacePath);
  if (!fallback) throw new ProviderDisabledError(provider);
  settings.log(`[provider-guard] requested ${provider} is disabled, using ${fallback.provider} (model ${fallback.model})`);
  return { ...fallback, redirected: true };
}

/**
 * Creates that describe history rather than a new run keep their provider:
 * imported external transcripts, branches (which resume the parent's provider
 * session) and re-creates of a row that already exists.
 */
function describesExistingHistory(payload: CreateSessionPayload): boolean {
  return payload.providerConfig?.imported === true || !!payload.branchedFromSessionId;
}

export function guardCreatePayload(
  payload: CreateSessionPayload,
  settings: SessionProviderGuardSettings,
): CreateSessionPayload {
  if (describesExistingHistory(payload)) return payload;
  const resolved = resolveEnabledSelection(
    { provider: payload.provider, model: payload.model, workspacePath: payload.workspaceId },
    settings,
  );
  if (!resolved.redirected) return payload;
  return { ...payload, provider: resolved.provider, model: resolved.model };
}

/**
 * Wrap the registered session store so `create` is guarded. Everything else
 * (including methods that use `this`) falls through to the wrapped store.
 */
export function withSessionProviderGuard(
  store: SessionStore,
  settings: SessionProviderGuardSettings,
): SessionStore {
  const guarded = Object.create(store) as SessionStore;
  guarded.create = async (payload: CreateSessionPayload): Promise<void> => {
    // An upsert onto an existing row is not a new session; leave it alone.
    const existing = await store.get(payload.id);
    if (existing) return store.create(payload);
    return store.create(guardCreatePayload(payload, settings));
  };
  return guarded;
}

let registeredSettings: SessionProviderGuardSettings | null = null;

/**
 * The main process registers the live settings once at startup. Call sites that
 * must vet a selection before building in-memory state (meta-agent spawn, mobile
 * create) use `resolveEnabledSelectionFromSettings`, so they do not import the
 * settings stores themselves. With nothing registered (unit tests of unrelated
 * code) it passes the selection through; the store guard is wired separately.
 */
export function registerSessionProviderGuardSettings(settings: SessionProviderGuardSettings | null): void {
  registeredSettings = settings;
}

export function resolveEnabledSelectionFromSettings(
  requested: { provider: string; model?: string | null; workspacePath?: string },
): ProviderSelection & { redirected: boolean } {
  if (!registeredSettings) {
    return { provider: requested.provider, model: requested.model ?? undefined, redirected: false };
  }
  return resolveEnabledSelection(requested, registeredSettings);
}
