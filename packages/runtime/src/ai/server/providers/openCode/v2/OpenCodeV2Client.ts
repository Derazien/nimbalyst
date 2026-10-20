/**
 * HTTP client for the OpenCode 2.x server API.
 *
 * OpenCode 2.x moved its API under `/api/*`, put it behind basic auth and
 * changed every payload; no 2.x JS SDK is published. This client implements the
 * same surface Nimbalyst uses from the 1.x SDK (`OpenCodeClientLike` plus the
 * model and agent catalog reads) and returns 1.x-shaped results, so the
 * protocol and both catalogs work unchanged against either server.
 *
 * Routes and payloads follow the server's own OpenAPI document
 * (`GET /openapi.json`) and were exercised against `opencode serve` 2.1.0.
 */

import type { OpenCodeClientLike, OpenCodeSSEEvent } from '../../../protocols/OpenCodeSDKProtocol';
import {
  OpenCodeV2EventTranslator,
  parseOpenCodeV2SseFrame,
} from './translateOpenCodeV2Event';

export interface OpenCodeV2Connection {
  baseUrl: string;
  /** Full `Authorization` header value, e.g. `Basic <base64(opencode:pw)>`. */
  authorization: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type DirectoryOptions = { query?: { directory?: string } } | undefined;

/** v1-shaped provider registry entry, as `mapProviderList` consumes it. */
export interface OpenCodeV2ProviderListPayload {
  all: Array<{ id: string; name: string; models: Record<string, Record<string, unknown>> }>;
  connected: string[];
}

export interface OpenCodeV2Client extends OpenCodeClientLike {
  provider: {
    list(options?: DirectoryOptions): Promise<{ data: OpenCodeV2ProviderListPayload }>;
  };
  app: {
    agents(options?: DirectoryOptions): Promise<{ data: Array<Record<string, unknown>> }>;
  };
}

/** Basic-auth header for a server started with `OPENCODE_PASSWORD`. */
export function openCodeV2Authorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export function createOpenCodeV2Client(
  connection: OpenCodeV2Connection,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): OpenCodeV2Client {
  const baseUrl = connection.baseUrl.replace(/\/+$/, '');

  async function request(
    method: string,
    route: string,
    options: { directory?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const url = `${baseUrl}${route}${locationQuery(options.directory)}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: connection.authorization,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenCode ${method} ${route} failed (${response.status}): ${describeError(text)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A 2xx HTML answer means the route does not exist on this server and
      // the web app's fallback page answered instead.
      throw new Error(`OpenCode ${method} ${route} returned a non-JSON response`);
    }
  }

  /**
   * Open the event stream before returning it. 2.x has no replay, so the
   * connection must exist before the caller sends the prompt whose events it
   * wants to see.
   */
  async function subscribe(directory: string | undefined): Promise<AsyncGenerator<OpenCodeSSEEvent>> {
    const controller = new AbortController();
    const response = await fetchImpl(`${baseUrl}/api/event`, {
      headers: { authorization: connection.authorization, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(`OpenCode GET /api/event failed (${response.status})`);
    }
    return readEvents(response, controller, directory);
  }

  async function* readEvents(
    response: Response,
    controller: AbortController,
    directory: string | undefined,
  ): AsyncGenerator<OpenCodeSSEEvent> {
    const translator = new OpenCodeV2EventTranslator(directory);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = nextFrameBoundary(buffer)) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, '');
          const event = parseOpenCodeV2SseFrame(frame);
          if (!event) continue;
          for (const translated of translator.translate(event)) {
            yield translated;
          }
        }
      }
    } finally {
      // Stop the server-wide stream when the consumer stops iterating.
      controller.abort();
    }
  }

  const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`;

  return {
    session: {
      async create(options) {
        const directory = readDirectory(options as DirectoryOptions);
        const result = (await request('POST', '/api/session', {
          body: directory ? { location: { directory } } : {},
        })) as { data?: { id?: string } } | null;
        const id = result?.data?.id;
        if (!id) throw new Error('OpenCode POST /api/session returned no session id');
        return { data: { ...result!.data, id } };
      },

      async list(options) {
        const result = (await request('GET', '/api/session', {
          directory: readDirectory(options as DirectoryOptions),
        })) as { data?: Array<{ id: string }> } | null;
        return { data: Array.isArray(result?.data) ? result!.data : [] };
      },

      async prompt(options) {
        const id = readPathId(options);
        const body = (options.body ?? {}) as {
          parts?: Array<Record<string, unknown>>;
          model?: { providerID?: string; modelID?: string };
          agent?: string;
        };
        // 2.x has no per-prompt model or agent: both are session state, set
        // just before the prompt so each turn still runs what the user picked.
        if (body.model?.providerID && body.model.modelID) {
          await request('POST', `${sessionPath(id)}/model`, {
            body: { model: { id: body.model.modelID, providerID: body.model.providerID } },
          });
        }
        if (body.agent) {
          await request('POST', `${sessionPath(id)}/agent`, { body: { agent: body.agent } });
        }
        const { text, files } = toPromptInput(body.parts ?? []);
        return request('POST', `${sessionPath(id)}/prompt`, {
          body: { text, ...(files.length > 0 ? { files } : {}) },
        });
      },

      async abort(options) {
        return request('POST', `${sessionPath(readPathId(options))}/interrupt`);
      },

      async summarize(options) {
        await request('POST', `${sessionPath(options.path.id)}/compact`, { body: {} });
        return { data: true };
      },
    },

    async postSessionIdPermissionsPermissionId(options) {
      await request(
        'POST',
        `${sessionPath(options.path.id)}/permission/${encodeURIComponent(options.path.permissionID)}/reply`,
        { body: { decision: options.body.response } },
      );
      return { data: true };
    },

    command: {
      async list(options) {
        const result = (await request('GET', '/api/command', {
          directory: options?.query?.directory,
        })) as { data?: Array<{ name?: unknown }> } | null;
        if (!Array.isArray(result?.data)) return { data: undefined, error: 'no command catalog' };
        const commands = result!.data
          .filter((command) => typeof command?.name === 'string')
          .map((command) => ({ name: command.name as string }));
        return { data: commands as never };
      },
    },

    event: {
      async subscribe(options) {
        return { stream: await subscribe(readDirectory(options as DirectoryOptions)) };
      },
    },

    global: {
      async event(options) {
        return { stream: await subscribe(readDirectory(options as DirectoryOptions)) };
      },
    },

    mcp: {
      async add(options) {
        const body = ((options ?? {}) as { body?: { name?: string; config?: unknown } }).body ?? {};
        if (!body.name) throw new Error('OpenCode MCP registration requires a server name');
        return request('PUT', `/api/experimental/mcp/${encodeURIComponent(body.name)}`, {
          directory: readDirectory(options as DirectoryOptions),
          body: { config: body.config },
        });
      },
    },

    provider: {
      async list(options) {
        const result = (await request('GET', '/api/model', {
          directory: readDirectory(options),
        })) as { data?: unknown } | null;
        if (!Array.isArray(result?.data)) {
          throw new Error('OpenCode GET /api/model returned no model list');
        }
        return { data: toProviderListPayload(result!.data) };
      },
    },

    app: {
      async agents(options) {
        const result = (await request('GET', '/api/agent', {
          directory: readDirectory(options),
        })) as { data?: unknown } | null;
        if (!Array.isArray(result?.data)) {
          throw new Error('OpenCode GET /api/agent returned no agent list');
        }
        return { data: result!.data.filter(isRecord).filter((agent) => agent.hidden !== true).map(toV1Agent) };
      },
    },
  };
}

/**
 * Regroup 2.x's flat model list into the 1.x `{ all, connected }` registry so
 * the catalog's existing mapper, ids (`opencode:<provider>/<model>`) and cache
 * format stay the same. 2.x lists only models it can reach; a model reported
 * `enabled: false` is dropped, and every provider left counts as connected.
 */
export function toProviderListPayload(models: unknown[]): OpenCodeV2ProviderListPayload {
  const providers = new Map<string, { id: string; name: string; models: Record<string, Record<string, unknown>> }>();
  for (const model of models) {
    if (!isRecord(model) || model.enabled === false) continue;
    const providerID = typeof model.providerID === 'string' ? model.providerID : '';
    const id = typeof model.id === 'string' ? model.id : '';
    if (!providerID || !id) continue;
    let provider = providers.get(providerID);
    if (!provider) {
      provider = { id: providerID, name: providerID, models: {} };
      providers.set(providerID, provider);
    }
    provider.models[id] = toV1Model(model, id);
  }
  return { all: [...providers.values()], connected: [...providers.keys()] };
}

function toV1Model(model: Record<string, unknown>, id: string): Record<string, unknown> {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : {};
  const input = stringList(capabilities.input);
  const output = stringList(capabilities.output);
  const limit = isRecord(model.limit) ? model.limit : {};
  const compatibility = isRecord(model.compatibility) ? model.compatibility : {};
  const cost = toV1Cost(model.cost);
  return {
    id,
    name: typeof model.name === 'string' && model.name ? model.name : id,
    status: model.status,
    limit: {
      context: typeof limit.context === 'number' ? limit.context : 0,
      output: typeof limit.output === 'number' ? limit.output : 0,
    },
    temperature: capabilities.temperature === true,
    reasoning: typeof compatibility.reasoningField === 'string',
    attachment: input.some((kind) => kind !== 'text'),
    tool_call: capabilities.tools === true,
    modalities: { input, output },
    ...(cost ? { cost } : {}),
  };
}

/**
 * 2.x prices a model as a list of tiers; the untiered entry is the base price
 * and a `context` tier of 200k maps onto 1.x's `context_over_200k`.
 */
function toV1Cost(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers = value.filter(isRecord);
  const base = tiers.find((tier) => !isRecord(tier.tier));
  if (!base) return undefined;
  const over200k = tiers.find(
    (tier) => isRecord(tier.tier) && tier.tier.type === 'context' && tier.tier.size === 200_000,
  );
  const flatten = (tier: Record<string, unknown>) => {
    const cache = isRecord(tier.cache) ? tier.cache : {};
    return {
      input: numberOrZero(tier.input),
      output: numberOrZero(tier.output),
      cache_read: numberOrZero(cache.read),
      cache_write: numberOrZero(cache.write),
    };
  };
  return { ...flatten(base), ...(over200k ? { context_over_200k: flatten(over200k) } : {}) };
}

const BUILT_IN_AGENTS = new Set(['build', 'plan', 'general', 'explore']);

/**
 * Map a 2.x agent onto the 1.x fields the agent catalog reads. 2.x replaced
 * the per-tool permission map with an ordered rule list; the effective
 * whole-resource effect per action is the last rule that matches it.
 */
function toV1Agent(agent: Record<string, unknown>): Record<string, unknown> {
  const id = typeof agent.id === 'string' ? agent.id : String(agent.name ?? '');
  const rules = Array.isArray(agent.permissions) ? agent.permissions.filter(isRecord) : [];
  const model = isRecord(agent.model) ? agent.model : undefined;
  return {
    name: id,
    ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
    mode: agent.mode,
    builtIn: BUILT_IN_AGENTS.has(id),
    ...(model && typeof model.providerID === 'string' && typeof model.id === 'string'
      ? { model: { providerID: model.providerID, modelID: model.id } }
      : {}),
    permission: {
      edit: effectFor(rules, 'edit'),
      bash: { '*': effectFor(rules, 'shell') },
      webfetch: effectFor(rules, 'webfetch'),
    },
  };
}

function effectFor(rules: Record<string, unknown>[], action: string): 'ask' | 'allow' | 'deny' {
  let effect: 'ask' | 'allow' | 'deny' = 'allow';
  for (const rule of rules) {
    if ((rule.action === action || rule.action === '*') && rule.resource === '*') {
      if (rule.effect === 'ask' || rule.effect === 'allow' || rule.effect === 'deny') {
        effect = rule.effect;
      }
    }
  }
  return effect;
}

/**
 * 1.x prompts are a list of parts; 2.x takes one text plus file attachments.
 * Text parts (the message and inlined documents) are joined in order; `data:`
 * file parts are passed through as attachment URIs, which 2.x inlines.
 */
function toPromptInput(parts: Array<Record<string, unknown>>): {
  text: string;
  files: Array<{ uri: string; name?: string }>;
} {
  const texts: string[] = [];
  const files: Array<{ uri: string; name?: string }> = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else if (part.type === 'file' && typeof part.url === 'string') {
      files.push({
        uri: part.url,
        ...(typeof part.filename === 'string' ? { name: part.filename } : {}),
      });
    }
  }
  return { text: texts.join('\n\n'), files };
}

function locationQuery(directory: string | undefined): string {
  return directory ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : '';
}

function nextFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function describeError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      const tag = typeof parsed._tag === 'string' ? parsed._tag : '';
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      if (tag || message) return [tag, message].filter(Boolean).join(': ');
    }
  } catch {
    // fall through to the raw body
  }
  return text.slice(0, 200) || 'no response body';
}

function readDirectory(options: DirectoryOptions): string | undefined {
  const directory = options?.query?.directory;
  return typeof directory === 'string' && directory.length > 0 ? directory : undefined;
}

function readPathId(options: Record<string, unknown>): string {
  const id = (options.path as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !id) throw new Error('OpenCode request requires a session id');
  return id;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
