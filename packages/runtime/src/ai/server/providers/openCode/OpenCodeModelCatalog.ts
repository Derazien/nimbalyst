import type { ProviderListResponses } from '@opencode-ai/sdk/client';
import { OPENCODE_PRESET_MODELS } from '../../../modelConstants';
import type { AIModel, AIProviderType } from '../../types';
import { OpenCodeServerManager } from '../../protocols/OpenCodeSDKProtocol';
import { createOpenCodeClientForServer } from './OpenCodeSdkClient';

const CATALOG_CACHE_VERSION = 2 as const;
const CATALOG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_MODELS = 5_000;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 512;

type ProviderListPayload = ProviderListResponses[200];

interface OpenCodeCatalogClient {
  provider: {
    list(options?: {
      query?: { directory?: string };
    }): Promise<{ data?: ProviderListPayload }>;
  };
}

interface OpenCodeCatalogServerManager {
  readonly isRunning: boolean;
  readonly baseUrl: string;
  ensureRunning(
    workspacePath: string,
    env?: Record<string, string>
  ): Promise<void>;
  release(): void;
}

export type OpenCodeModelCatalogCacheStatus = 'cold' | 'ready' | 'stale';
export type OpenCodeModelCatalogStaleReason = 'identity-changed' | 'expired';

export interface OpenCodeModelCatalogCache {
  version: typeof CATALOG_CACHE_VERSION;
  cacheKey: string;
  workspacePath: string;
  models: AIModel[];
  refreshedAt: number;
}

export interface OpenCodeModelCatalogSnapshot {
  models: AIModel[];
  cacheStatus: OpenCodeModelCatalogCacheStatus;
  refreshedAt: number | null;
  staleReason?: OpenCodeModelCatalogStaleReason;
  error?: string;
}

export interface OpenCodeModelCatalogDependencies {
  /**
   * Read this workspace's persisted catalog. Hosts key their storage by
   * workspace: OpenCode resolves providers from project-level config, so one
   * project's discovery result is not an answer for another (#1382).
   */
  loadCache?: (workspacePath: string) => unknown | Promise<unknown>;
  saveCache?: (cache: OpenCodeModelCatalogCache) => void | Promise<void>;
  getCacheKey?: (workspacePath: string) => string | Promise<string>;
  /**
   * Model ids the user has already committed to (currently the OpenCode default
   * model in opencode.json). These survive in the catalog even when discovery
   * says their provider is not connected -- see keepRetainedModels().
   */
  getRetainedModelIds?: () => string[] | Promise<string[]>;
  getEnvironment?: () => Record<string, string> | undefined;
  createClient?: (
    baseUrl: string
  ) => OpenCodeCatalogClient | Promise<OpenCodeCatalogClient>;
  getServerManager?: () => OpenCodeCatalogServerManager;
  now?: () => number;
}

const defaultDependencies: Required<OpenCodeModelCatalogDependencies> = {
  loadCache: () => null,
  saveCache: () => undefined,
  getCacheKey: () => 'unconfigured',
  getRetainedModelIds: () => [],
  getEnvironment: () => undefined,
  createClient: async (baseUrl) => {
    const connection = OpenCodeServerManager.getInstance().connection;
    return (await createOpenCodeClientForServer(
      connection.baseUrl === baseUrl ? connection : { baseUrl, apiVersion: null, authorization: null }
    )) as OpenCodeCatalogClient;
  },
  getServerManager: () => OpenCodeServerManager.getInstance(),
  now: () => Date.now(),
};

let dependencies = { ...defaultDependencies };

/**
 * Supply host-owned persistence and identity readers. Electron configures this
 * once during main-process startup; runtime-only hosts retain the safe cold
 * cache behavior.
 */
export function configureOpenCodeModelCatalog(
  next: OpenCodeModelCatalogDependencies
): void {
  dependencies = { ...dependencies, ...next };
}

/** Test-only reset for the module-level host dependency registry. */
export function resetOpenCodeModelCatalogForTests(): void {
  dependencies = { ...defaultDependencies };
}

/**
 * Read this workspace's cache and opportunistically refresh it only when an
 * OpenCode server is already alive. This function never starts a server.
 *
 * `workspacePath` is required on purpose. It used to be optional and silently
 * degraded to the preset list, which reads exactly like a real catalog -- so
 * two of four call sites omitted it and every install's model picker showed
 * seven hardcoded models forever (#1382). A caller that genuinely has no
 * workspace must say so by naming getOpenCodeColdModelCatalog().
 */
export async function getOpenCodeModelCatalog(
  workspacePath: string
): Promise<OpenCodeModelCatalogSnapshot> {
  const normalizedWorkspacePath = workspacePath?.trim();
  if (!normalizedWorkspacePath) {
    throw new Error('OpenCode model catalog read requires workspacePath');
  }
  const cached = await readCachedCatalog(normalizedWorkspacePath);
  const manager = dependencies.getServerManager();
  if (!manager.isRunning) {
    return cached;
  }

  try {
    return await refreshFromServer(manager, normalizedWorkspacePath);
  } catch (error) {
    return {
      ...cached,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Explicit user-action refresh. Unlike getOpenCodeModelCatalog(), this may
 * acquire and start the ref-counted OpenCode server for the supplied workspace.
 */
export async function refreshOpenCodeModelCatalog(
  workspacePath: string
): Promise<OpenCodeModelCatalogSnapshot> {
  if (!workspacePath.trim()) {
    throw new Error('OpenCode model catalog refresh requires workspacePath');
  }

  const manager = dependencies.getServerManager();
  try {
    await manager.ensureRunning(workspacePath, dependencies.getEnvironment());
    return await refreshFromServer(manager, workspacePath);
  } finally {
    // ensureRunning increments the manager reference before startup, including
    // paths that reject, so always balance the acquisition.
    manager.release();
  }
}

/**
 * The offline fallback on its own: the preset list plus whatever the user has
 * already selected, with no discovery behind it. Only for hosts that have no
 * workspace to read for -- mobile model sync, a picker opened outside any
 * project. Naming it is the point; see getOpenCodeModelCatalog().
 */
export async function getOpenCodeColdModelCatalog(): Promise<OpenCodeModelCatalogSnapshot> {
  return coldCatalog(await readRetainedModelIds());
}

async function readCachedCatalog(
  workspacePath: string
): Promise<OpenCodeModelCatalogSnapshot> {
  const retained = await readRetainedModelIds();

  const [rawCache, cacheKey] = await Promise.all([
    dependencies.loadCache(workspacePath),
    dependencies.getCacheKey(workspacePath),
  ]);
  const cache = normalizeCache(rawCache, workspacePath);

  // Presets are the offline fallback only: they describe what OpenCode can
  // usually reach, not what this install discovered. Nothing here is verified,
  // so retained selections are listed plainly rather than marked unavailable.
  if (!cache) return coldCatalog(retained);

  if (cache.cacheKey !== cacheKey) {
    return {
      models: keepRetainedModels(getPresetModels(), retained, false),
      cacheStatus: 'stale',
      refreshedAt: cache.refreshedAt,
      staleReason: 'identity-changed',
    };
  }

  const expired =
    dependencies.now() - cache.refreshedAt > CATALOG_STALE_AFTER_MS;
  return {
    // A discovered catalog stands on its own -- presets are not merged back in,
    // or every install would keep showing hardcoded models it may not have
    // credentials for (#916).
    models: keepRetainedModels(cache.models, retained, !expired),
    cacheStatus: expired ? 'stale' : 'ready',
    refreshedAt: cache.refreshedAt,
    ...(expired ? { staleReason: 'expired' as const } : {}),
  };
}

async function refreshFromServer(
  manager: OpenCodeCatalogServerManager,
  workspacePath: string
): Promise<OpenCodeModelCatalogSnapshot> {
  const cacheKeyBeforeRequest = await dependencies.getCacheKey(workspacePath);
  const client = await dependencies.createClient(manager.baseUrl);
  const response = await client.provider.list({ query: { directory: workspacePath } });
  if (!response.data) {
    throw new Error('OpenCode provider.list returned no catalog data');
  }

  const discovered = mapProviderList(response.data);
  const cacheKeyAfterRequest = await dependencies.getCacheKey(workspacePath);
  if (cacheKeyAfterRequest !== cacheKeyBeforeRequest) {
    throw new Error(
      'OpenCode binary or authentication changed during catalog refresh'
    );
  }
  const refreshedAt = dependencies.now();
  const cache: OpenCodeModelCatalogCache = {
    version: CATALOG_CACHE_VERSION,
    cacheKey: cacheKeyAfterRequest,
    workspacePath,
    models: discovered,
    refreshedAt,
  };
  await dependencies.saveCache(cache);

  return {
    models: keepRetainedModels(discovered, await readRetainedModelIds(), true),
    cacheStatus: 'ready',
    refreshedAt,
  };
}

/**
 * provider.list answers two different questions. `all` is OpenCode's entire
 * registry of known providers -- dozens of them, hundreds of models the user has
 * no credentials for. `connected` is the set of provider ids this user is
 * actually authenticated for.
 *
 * The catalog is the connected subset. That is what #916 and #859 asked for:
 * every provider the user has configured, including ones Nimbalyst never
 * hardcoded (OpenRouter, a local bridge), and nothing they cannot run. It is a
 * discovery filter, not a curated list -- models are only ever dropped because
 * this install has no credentials for them, never because of our taste.
 */
function mapProviderList(payload: ProviderListPayload): AIModel[] {
  const connected = resolveConnectedProviderIds(payload);
  const models: AIModel[] = [];
  for (const provider of payload.all) {
    if (connected && !connected.has(provider.id)) continue;
    for (const model of Object.values(provider.models)) {
      const id = `opencode:${provider.id}/${model.id}`;
      if (
        !isBoundedString(provider.id, MAX_MODEL_ID_LENGTH) ||
        !isBoundedString(model.id, MAX_MODEL_ID_LENGTH) ||
        !isBoundedString(model.name, MAX_MODEL_NAME_LENGTH) ||
        id.length > MAX_MODEL_ID_LENGTH
      ) {
        continue;
      }

      models.push({
        id,
        name: model.name,
        provider: 'opencode',
        contextWindow: model.limit.context,
        maxTokens: model.limit.output,
        status: model.status ?? 'active',
        capabilities: {
          temperature: model.temperature,
          reasoning: model.reasoning,
          attachment: model.attachment,
          toolcall: model.tool_call,
          input: modalitiesToCapabilities(model.modalities?.input),
          output: modalitiesToCapabilities(model.modalities?.output),
        },
        ...(model.cost
          ? {
              cost: {
                input: model.cost.input,
                output: model.cost.output,
                cache: {
                  read: model.cost.cache_read ?? 0,
                  write: model.cost.cache_write ?? 0,
                },
                ...(model.cost.context_over_200k
                  ? {
                      experimentalOver200K: {
                        input: model.cost.context_over_200k.input,
                        output: model.cost.context_over_200k.output,
                        cache: {
                          read: model.cost.context_over_200k.cache_read ?? 0,
                          write: model.cost.context_over_200k.cache_write ?? 0,
                        },
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
      if (models.length >= MAX_PERSISTED_MODELS) return models;
    }
  }
  return models;
}

/**
 * Null means "this server did not report connectedness", in which case the
 * whole registry is kept rather than shipping an empty picker. An empty array
 * is a real answer -- no provider is authenticated -- and is honored.
 */
function resolveConnectedProviderIds(
  payload: ProviderListPayload
): Set<string> | null {
  if (!Array.isArray(payload.connected)) return null;
  return new Set(payload.connected);
}

/**
 * Keep the ids the user already selected in the list even when discovery says
 * their provider is not connected. Revoking a key, or discovery running before
 * the user finishes authenticating, must not silently erase the model a session
 * is configured with -- it shows up as unusable instead (#916).
 */
function keepRetainedModels(
  models: AIModel[],
  retained: string[],
  markUnavailable: boolean
): AIModel[] {
  if (retained.length === 0) return models;
  const known = new Set(models.map((model) => model.id));
  const missing = retained
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      name: id.replace(/^opencode:/, ''),
      provider: 'opencode' as AIProviderType,
      ...(markUnavailable ? { unavailable: true } : {}),
    }));
  return missing.length > 0 ? [...models, ...missing] : models;
}

async function readRetainedModelIds(): Promise<string[]> {
  try {
    const ids = await dependencies.getRetainedModelIds();
    const normalized = ids
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter((id) => id.length > 0)
      .map((id) => (id.startsWith('opencode:') ? id : `opencode:${id}`));
    return Array.from(new Set(normalized));
  } catch {
    // Retention is a safety net, not a requirement -- a host that cannot answer
    // must not take the catalog down with it.
    return [];
  }
}

function modalitiesToCapabilities(
  modalities: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'> | undefined
) {
  const supported = new Set(modalities ?? []);
  return {
    text: supported.has('text'),
    audio: supported.has('audio'),
    image: supported.has('image'),
    video: supported.has('video'),
    pdf: supported.has('pdf'),
  };
}

function getPresetModels(): AIModel[] {
  return OPENCODE_PRESET_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    provider: 'opencode' as AIProviderType,
  }));
}

function coldCatalog(retained: string[]): OpenCodeModelCatalogSnapshot {
  return {
    models: keepRetainedModels(getPresetModels(), retained, false),
    cacheStatus: 'cold',
    refreshedAt: null,
  };
}

const CACHE_DEFAULTS: OpenCodeModelCatalogCache = {
  version: CATALOG_CACHE_VERSION,
  cacheKey: '',
  workspacePath: '',
  models: [],
  refreshedAt: 0,
};

const MODEL_DEFAULTS: AIModel = {
  id: '',
  name: '',
  provider: 'opencode',
};

function normalizeCache(
  value: unknown,
  workspacePath: string
): OpenCodeModelCatalogCache | null {
  if (!isRecord(value)) return null;
  const merged = { ...CACHE_DEFAULTS, ...value };
  if (
    merged.version !== CATALOG_CACHE_VERSION ||
    !isBoundedString(merged.cacheKey, 512) ||
    merged.workspacePath !== workspacePath ||
    !Number.isFinite(merged.refreshedAt) ||
    !Array.isArray(merged.models)
  ) {
    return null;
  }

  const models = merged.models
    .slice(0, MAX_PERSISTED_MODELS)
    .map(normalizeCachedModel)
    .filter((model): model is AIModel => model !== null);
  if (merged.models.length > 0 && models.length === 0) return null;

  return {
    version: CATALOG_CACHE_VERSION,
    cacheKey: merged.cacheKey,
    workspacePath,
    models,
    refreshedAt: merged.refreshedAt,
  };
}

function normalizeCachedModel(value: unknown): AIModel | null {
  if (!isRecord(value)) return null;
  const merged = { ...MODEL_DEFAULTS, ...value };
  if (
    merged.provider !== 'opencode' ||
    !isBoundedString(merged.id, MAX_MODEL_ID_LENGTH) ||
    !isBoundedString(merged.name, MAX_MODEL_NAME_LENGTH)
  ) {
    return null;
  }

  const model: AIModel = {
    id: merged.id,
    name: merged.name,
    provider: 'opencode',
  };
  if (isNonNegativeFiniteNumber(merged.maxTokens)) model.maxTokens = merged.maxTokens;
  if (isNonNegativeFiniteNumber(merged.contextWindow)) model.contextWindow = merged.contextWindow;
  if (isModelStatus(merged.status)) model.status = merged.status;
  if (typeof merged.unavailable === 'boolean') model.unavailable = merged.unavailable;
  if (isRecord(merged.capabilities)) {
    model.capabilities = normalizeCapabilities(merged.capabilities);
  }
  if (isRecord(merged.cost)) {
    model.cost = normalizeCost(merged.cost);
  }
  return model;
}

function normalizeCapabilities(value: Record<string, unknown>): NonNullable<AIModel['capabilities']> {
  const normalizeModalities = (input: unknown) => {
    const source = isRecord(input) ? input : {};
    return {
      text: source.text === true,
      audio: source.audio === true,
      image: source.image === true,
      video: source.video === true,
      pdf: source.pdf === true,
    };
  };
  return {
    temperature: value.temperature === true,
    reasoning: value.reasoning === true,
    attachment: value.attachment === true,
    toolcall: value.toolcall === true,
    input: normalizeModalities(value.input),
    output: normalizeModalities(value.output),
  };
}

function normalizeCost(value: Record<string, unknown>): NonNullable<AIModel['cost']> {
  const cache = isRecord(value.cache) ? value.cache : {};
  const normalized: NonNullable<AIModel['cost']> = {
    input: toNonNegativeFiniteNumber(value.input),
    output: toNonNegativeFiniteNumber(value.output),
    cache: {
      read: toNonNegativeFiniteNumber(cache.read),
      write: toNonNegativeFiniteNumber(cache.write),
    },
  };
  if (isRecord(value.experimentalOver200K)) {
    const over200K = value.experimentalOver200K;
    const over200KCache = isRecord(over200K.cache) ? over200K.cache : {};
    normalized.experimentalOver200K = {
      input: toNonNegativeFiniteNumber(over200K.input),
      output: toNonNegativeFiniteNumber(over200K.output),
      cache: {
        read: toNonNegativeFiniteNumber(over200KCache.read),
        write: toNonNegativeFiniteNumber(over200KCache.write),
      },
    };
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toNonNegativeFiniteNumber(value: unknown): number {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}

function isModelStatus(value: unknown): value is NonNullable<AIModel['status']> {
  return value === 'alpha' || value === 'beta' || value === 'deprecated' || value === 'active';
}
