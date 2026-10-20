// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  createOpenCodeV2Client,
  openCodeV2Authorization,
  toProviderListPayload,
} from '../OpenCodeV2Client';
import type { OpenCodeSSEEvent } from '../../../../protocols/OpenCodeSDKProtocol';

const BASE_URL = 'http://127.0.0.1:4096';
const AUTHORIZATION = openCodeV2Authorization('s3cret');

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(responder: Responder = () => json({ data: {} })) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: input,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return responder(call);
  };
  const client = createOpenCodeV2Client({ baseUrl: `${BASE_URL}/`, authorization: AUTHORIZATION }, fetchImpl);
  return { client, calls };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ id: 'evt_1', type, data, ...extra })}`;
}

/** Translated events, read by key in assertions. */
interface LooseEvent {
  type: string;
  properties: any;
}

async function collect(stream: AsyncIterable<OpenCodeSSEEvent>): Promise<LooseEvent[]> {
  const out: LooseEvent[] = [];
  for await (const event of stream) out.push(event as LooseEvent);
  return out;
}

describe('openCodeV2Authorization', () => {
  it('is basic auth for the fixed username "opencode"', () => {
    expect(AUTHORIZATION).toBe(`Basic ${Buffer.from('opencode:s3cret').toString('base64')}`);
  });
});

describe('OpenCodeV2Client requests', () => {
  it('sends the Basic auth header on every call, including the event stream', async () => {
    const { client, calls } = setup((call) =>
      call.url.endsWith('/api/event') ? sseResponse([]) : json({ data: { id: 'ses_1' } }),
    );
    await client.session.create({ query: { directory: '/work/project' } } as never);
    await client.session.list({} as never);
    await client.session.prompt({ path: { id: 'ses_1' }, body: { parts: [{ type: 'text', text: 'hi' }] } } as never);
    await client.session.abort({ path: { id: 'ses_1' } } as never);
    await client.session.summarize({ path: { id: 'ses_1' }, body: {} } as never);
    await client.command.list({} as never);
    await client.mcp.add({ body: { name: 'x', config: {} } } as never);
    await client.provider.list({}).catch(() => undefined);
    await client.app.agents({}).catch(() => undefined);
    await collect((await client.event.subscribe({} as never)).stream as AsyncIterable<OpenCodeSSEEvent>);

    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) expect(call.headers.authorization).toBe(AUTHORIZATION);
  });

  it('creates a session bound to a directory and returns the id in the 1.x shape', async () => {
    const { client, calls } = setup(() => json({ data: { id: 'ses_9', slug: 'brave' }, location: {} }));
    const result = await client.session.create({ query: { directory: 'C:\\work\\proj' } } as never);

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${BASE_URL}/api/session`,
      body: { location: { directory: 'C:\\work\\proj' } },
    });
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(result.data).toMatchObject({ id: 'ses_9', slug: 'brave' });
  });

  it('creates a session with an empty body when no directory is given, and rejects a reply with no id', async () => {
    const { client, calls } = setup(() => json({ data: {} }));
    await expect(client.session.create({} as never)).rejects.toThrow('returned no session id');
    expect(calls[0].body).toEqual({});
  });

  it('lists sessions with location[directory] percent-encoded in the query', async () => {
    const { client, calls } = setup(() => json({ data: [{ id: 'ses_1' }] }));
    const result = await client.session.list({ query: { directory: 'C:\\work\\my proj' } } as never);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(
      `${BASE_URL}/api/session?location%5Bdirectory%5D=${encodeURIComponent('C:\\work\\my proj')}`,
    );
    expect(calls[0].body).toBeUndefined();
    expect(result.data).toEqual([{ id: 'ses_1' }]);
  });

  it('switches model and agent, then prompts with the joined text and file attachments', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    await client.session.prompt({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'opencode', modelID: 'big-pickle' },
        agent: 'plan',
        parts: [
          { type: 'text', text: 'first' },
          { type: 'file', url: 'data:image/png;base64,AAA', filename: 'a.png', mime: 'image/png' },
          { type: 'text', text: 'second' },
          { type: 'file', url: 'data:text/plain;base64,BBB' },
        ],
      },
    } as never);

    expect(calls.map((c) => `${c.method} ${c.url.replace(BASE_URL, '')}`)).toEqual([
      'POST /api/session/ses_1/model',
      'POST /api/session/ses_1/agent',
      'POST /api/session/ses_1/prompt',
    ]);
    expect(calls[0].body).toEqual({ model: { id: 'big-pickle', providerID: 'opencode' } });
    expect(calls[1].body).toEqual({ agent: 'plan' });
    expect(calls[2].body).toEqual({
      text: 'first\n\nsecond',
      files: [{ uri: 'data:image/png;base64,AAA', name: 'a.png' }, { uri: 'data:text/plain;base64,BBB' }],
    });
  });

  it('prompts without a model or agent switch or a files key when none is given', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    await client.session.prompt({
      path: { id: 'ses/1' },
      body: { parts: [{ type: 'text', text: 'hi' }] },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/api/session/ses%2F1/prompt`);
    expect(calls[0].body).toEqual({ text: 'hi' });
  });

  it('does not send the prompt when switching the model is refused', async () => {
    const { client, calls } = setup((call) =>
      call.url.endsWith('/model') ? json({ _tag: 'ModelNotFound', message: 'no such model' }, 404) : json({}),
    );
    await expect(
      client.session.prompt({
        path: { id: 'ses_1' },
        body: { model: { providerID: 'x', modelID: 'y' }, parts: [{ type: 'text', text: 'hi' }] },
      } as never),
    ).rejects.toThrow('ModelNotFound: no such model');
    expect(calls).toHaveLength(1);
  });

  it('aborts through interrupt and summarizes through compact', async () => {
    const { client, calls } = setup((call) =>
      call.url.endsWith('/interrupt') ? json({ data: { interrupted: true } }) : new Response(null, { status: 204 }),
    );
    const aborted = await client.session.abort({ path: { id: 'ses_1' } } as never);
    const summarized = await client.session.summarize({
      path: { id: 'ses_1' },
      body: { providerID: 'opencode', modelID: 'big-pickle' },
    } as never);

    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE_URL}/api/session/ses_1/interrupt` });
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers['content-type']).toBeUndefined();
    expect(aborted).toEqual({ data: { interrupted: true } });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BASE_URL}/api/session/ses_1/compact`, body: {} });
    expect(summarized).toEqual({ data: true });
  });

  it('replies to a permission with a decision', async () => {
    const { client, calls } = setup(() => new Response(null, { status: 204 }));
    for (const response of ['once', 'always', 'reject'] as const) {
      const result = await client.postSessionIdPermissionsPermissionId({
        path: { id: 'ses_1', permissionID: 'per_1' },
        body: { response },
      } as never);
      expect(result).toEqual({ data: true });
    }
    expect(calls.map((c) => c.url)).toEqual(
      Array(3).fill(`${BASE_URL}/api/session/ses_1/permission/per_1/reply`),
    );
    expect(calls.map((c) => c.body)).toEqual([
      { decision: 'once' },
      { decision: 'always' },
      { decision: 'reject' },
    ]);
  });

  it('lists slash commands by name and reports a missing catalog as an error result', async () => {
    const { client, calls } = setup(() => json({ data: [{ name: 'review', description: 'x' }, { name: 3 }, {}] }));
    const result = await client.command.list({ query: { directory: '/ws' } } as never);
    expect(calls[0].url).toBe(`${BASE_URL}/api/command?location%5Bdirectory%5D=%2Fws`);
    expect(result.data).toEqual([{ name: 'review' }]);

    const broken = setup(() => json({ data: 'nope' }));
    expect(await broken.client.command.list({} as never)).toMatchObject({ data: undefined, error: expect.any(String) });
  });

  it('registers an MCP server with PUT on the experimental route', async () => {
    const { client, calls } = setup(() => json({ data: true }));
    const config = { type: 'local', command: ['node', 'srv.js'] };
    await client.mcp.add({ query: { directory: '/ws' }, body: { name: 'nim/mcp', config } } as never);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE_URL}/api/experimental/mcp/${encodeURIComponent('nim/mcp')}?location%5Bdirectory%5D=%2Fws`,
      body: { config },
    });
    await expect(client.mcp.add({ body: { config } } as never)).rejects.toThrow('requires a server name');
  });
});

describe('OpenCodeV2Client catalogs', () => {
  const MODELS = [
    {
      id: 'big-pickle',
      providerID: 'opencode',
      name: 'Big Pickle',
      status: 'active',
      enabled: true,
      limit: { context: 200_000, output: 32_000 },
      capabilities: { tools: true, temperature: true, input: ['text', 'image'], output: ['text'] },
      compatibility: { reasoningField: 'reasoning_content' },
      cost: [
        { input: 1, output: 2, cache: { read: 0.1, write: 0.5 } },
        { tier: { type: 'context', size: 200_000 }, input: 3, output: 6, cache: { read: 0.3 } },
      ],
    },
    { id: 'gpt-5', providerID: 'openai', capabilities: { input: ['text'], output: ['text'] } },
    { id: 'disabled', providerID: 'openai', enabled: false },
    { providerID: 'openai' },
  ];

  it('reads provider.list from /api/model and regroups it into the 1.x registry', async () => {
    const { client, calls } = setup(() => json({ data: MODELS }));
    const { data } = await client.provider.list({ query: { directory: '/ws' } });

    expect(calls[0].url).toBe(`${BASE_URL}/api/model?location%5Bdirectory%5D=%2Fws`);
    expect(data.connected).toEqual(['opencode', 'openai']);
    expect(data.all.map((p) => [p.id, Object.keys(p.models)])).toEqual([
      ['opencode', ['big-pickle']],
      ['openai', ['gpt-5']],
    ]);
    expect(data.all[0].models['big-pickle']).toEqual({
      id: 'big-pickle',
      name: 'Big Pickle',
      status: 'active',
      limit: { context: 200_000, output: 32_000 },
      temperature: true,
      reasoning: true,
      attachment: true,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      cost: {
        input: 1,
        output: 2,
        cache_read: 0.1,
        cache_write: 0.5,
        context_over_200k: { input: 3, output: 6, cache_read: 0.3, cache_write: 0 },
      },
    });
    // Sparse models still get safe defaults.
    expect(data.all[1].models['gpt-5']).toMatchObject({
      name: 'gpt-5',
      limit: { context: 0, output: 0 },
      attachment: false,
      tool_call: false,
    });
  });

  it('fails provider.list when the server did not answer with a model list', async () => {
    const { client } = setup(() => json({ data: { not: 'a list' } }));
    await expect(client.provider.list({})).rejects.toThrow('returned no model list');
    expect(toProviderListPayload([])).toEqual({ all: [], connected: [] });
  });

  it('maps app.agents from /api/agent, hiding hidden agents', async () => {
    const { client, calls } = setup(() =>
      json({
        data: [
          {
            id: 'build',
            name: 'Build',
            mode: 'primary',
            description: 'Builds',
            permissions: [
              { action: '*', resource: '*', effect: 'allow' },
              { action: 'shell', resource: '*', effect: 'ask' },
              { action: 'edit', resource: 'secret/*', effect: 'deny' },
            ],
          },
          {
            id: 'reviewer',
            mode: 'subagent',
            model: { id: 'big-pickle', providerID: 'opencode' },
            permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
          },
          { id: 'title', hidden: true },
        ],
      }),
    );
    const { data } = await client.app.agents({ query: { directory: '/ws' } });
    expect(calls[0].url).toBe(`${BASE_URL}/api/agent?location%5Bdirectory%5D=%2Fws`);
    expect(data).toEqual([
      {
        name: 'build',
        description: 'Builds',
        mode: 'primary',
        builtIn: true,
        permission: { edit: 'allow', bash: { '*': 'ask' }, webfetch: 'allow' },
      },
      {
        name: 'reviewer',
        mode: 'subagent',
        builtIn: false,
        model: { providerID: 'opencode', modelID: 'big-pickle' },
        permission: { edit: 'deny', bash: { '*': 'allow' }, webfetch: 'allow' },
      },
    ]);
  });
});

describe('OpenCodeV2Client errors', () => {
  it('maps a { _tag, message } error body into the thrown message with route and status', async () => {
    const { client } = setup(() => json({ _tag: 'SessionNotFound', message: 'No session ses_x' }, 404));
    await expect(client.session.abort({ path: { id: 'ses_x' } } as never)).rejects.toThrow(
      'OpenCode POST /api/session/ses_x/interrupt failed (404): SessionNotFound: No session ses_x',
    );
  });

  it('falls back to the raw body, then to a placeholder, for non-JSON errors', async () => {
    const text = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(text.client.session.list({} as never)).rejects.toThrow('(502): <html>bad gateway</html>');
    const empty = setup(() => new Response(null, { status: 500 }));
    await expect(empty.client.session.list({} as never)).rejects.toThrow('(500): no response body');
  });

  it('rejects a 200 that is not JSON, as the web app answers an unknown route', async () => {
    const { client } = setup(
      () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(client.session.list({} as never)).rejects.toThrow('returned a non-JSON response');
  });

  it('requires a session id on id-bound calls', async () => {
    const { client } = setup();
    await expect(client.session.abort({} as never)).rejects.toThrow('requires a session id');
  });
});

describe('OpenCodeV2Client event stream', () => {
  it('opens GET /api/event before returning and yields translated 1.x events', async () => {
    const { client, calls } = setup(() =>
      sseResponse([
        `${frame('server.connected', {})}\n\n`,
        `${frame('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: 'hi' })}\n\n`,
        `${frame('session.execution.succeeded', { sessionID: 'ses_1' })}\n\n`,
      ]),
    );
    const subscription = await client.event.subscribe({ query: { directory: '/ws' } } as never);

    // The request went out at subscribe time, not at first iteration.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/api/event`);
    expect(calls[0].headers.accept).toBe('text/event-stream');

    const events = await collect(subscription.stream as AsyncIterable<OpenCodeSSEEvent>);
    expect(events.map((e) => e.type)).toEqual(['server.connected', 'message.part.delta', 'session.idle']);
    expect(events[1].properties).toMatchObject({ sessionID: 'ses_1', field: 'text', delta: 'hi' });
  });

  it('reassembles frames split across chunks, skips heartbeats and accepts CRLF separators', async () => {
    const delta = (text: string) =>
      frame('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: text });
    const whole = `${delta('one')}\n\n: heartbeat\n\n${delta('two')}\r\n\r\n${delta('three')}\n\n`;
    // Cut into awkward 7-byte chunks so frames, separators and the heartbeat all straddle chunks.
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7));

    const { client } = setup(() => sseResponse(chunks));
    const { stream } = await client.event.subscribe({} as never);
    const events = await collect(stream as AsyncIterable<OpenCodeSSEEvent>);
    expect(events.map((e) => e.properties.delta)).toEqual(['one', 'two', 'three']);
  });

  it('does not corrupt a multi-byte character split between chunks', async () => {
    const full = `${frame('session.text.delta', {
      sessionID: 'ses_1',
      assistantMessageID: 'msg_1',
      ordinal: 0,
      delta: 'caf\u00e9 \u2713',
    })}\n\n`;
    const bytes = new TextEncoder().encode(full);
    const cut = full.indexOf('\u00e9');
    const splitAt = new TextEncoder().encode(full.slice(0, cut)).length + 1; // between the two bytes of "e acute"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const { client } = setup(() => new Response(stream, { status: 200 }));
    const sub = await client.event.subscribe({} as never);
    const events = await collect(sub.stream as AsyncIterable<OpenCodeSSEEvent>);
    expect(events[0].properties.delta).toBe('caf\u00e9 \u2713');
  });

  it('resolves edited files against the subscribed directory when events carry no location', async () => {
    const { client } = setup(() =>
      sseResponse([
        `${frame('session.tool.success', { sessionID: 'ses_1', id: 'c1', content: [], metadata: { files: [{ file: 'a.ts' }] } })}\n\n`,
      ]),
    );
    const { stream } = await client.global.event({ query: { directory: '/ws' } } as never);
    const events = await collect(stream as AsyncIterable<OpenCodeSSEEvent>);
    expect(events.find((e) => e.type === 'file.edited')?.properties.file).toBe(path.join('/ws', 'a.ts'));
  });

  it('closes the server-wide connection when the consumer stops reading', async () => {
    let aborted = false;
    const { client } = setup((call) => {
      call.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${frame('server.connected', {})}\n\n`));
            // never closes: a live server-wide stream
          },
        }),
        { status: 200 },
      );
    });
    const { stream } = await client.event.subscribe({} as never);
    for await (const _event of stream as AsyncIterable<OpenCodeSSEEvent>) break;
    expect(aborted).toBe(true);
  });

  it('rejects subscribe when the stream cannot be opened', async () => {
    const { client } = setup(() => json({ _tag: 'Unauthorized', message: 'no' }, 401));
    await expect(client.event.subscribe({} as never)).rejects.toThrow('GET /api/event failed (401)');
  });
});
