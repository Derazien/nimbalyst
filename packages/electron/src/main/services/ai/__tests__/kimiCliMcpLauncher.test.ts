// @vitest-environment node
/**
 * The launcher kimi starts for every Nimbalyst MCP server in a Kimi Code CLI
 * session (resources/kimiCliMcpLauncher.cjs), run as the real script against
 * real local servers: what kimi would see on its stdio.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';

const LAUNCHER = path.resolve(__dirname, '../../../../../resources/kimiCliMcpLauncher.cjs');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-mcp-launcher-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Speak MCP to the launcher the way kimi does: one JSON message per line. */
function startLauncher(serverName: string, env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [LAUNCHER, serverName], {
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  cleanups.push(() => child.kill());
  const waiting = new Map<number, (message: any) => void>();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const handshake = async () => {
    const init = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kimi-code', version: '2.0.2' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return init;
  };
  return { request, handshake };
}

function writeSessionFile(mcpServers: Record<string, unknown>): string {
  const file = path.join(tempDir(), 'session.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers }));
  return file;
}

const TOOL = { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } };
function answer(message: any, extra: string): unknown {
  if (message.method === 'initialize') return { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (message.method === 'tools/list') return { tools: [TOOL] };
  if (message.method === 'tools/call') return { content: [{ type: 'text', text: `${extra}:${message.params.arguments.text}` }] };
  return {};
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

describe('kimiCliMcpLauncher', () => {
  it('is an empty MCP server when kimi was not started by Nimbalyst or the session has no such server', async () => {
    const outside = startLauncher('nimbalyst-host', { NIMBALYST_KIMI_MCP_CONFIG: '' });
    expect((await outside.handshake()).result.capabilities).toEqual({ tools: {} });
    expect((await outside.request('tools/list')).result).toEqual({ tools: [] });

    const otherWorkspace = startLauncher('only-in-another-project', {
      NIMBALYST_KIMI_MCP_CONFIG: writeSessionFile({ 'nimbalyst-host': { type: 'sse', url: 'http://127.0.0.1:1/mcp' } }),
    });
    await otherWorkspace.handshake();
    expect((await otherWorkspace.request('tools/list')).result).toEqual({ tools: [] });
  }, 20_000);

  it('runs a stdio server from the session file with the environment it was given', async () => {
    const script = path.join(tempDir(), 'server.cjs');
    fs.writeFileSync(script, `
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
          const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (message.id === undefined) continue;
          const result = message.method === 'tools/list' ? { tools: [${JSON.stringify(TOOL)}] }
            : message.method === 'tools/call' ? { content: [{ type: 'text', text: process.env.FIXTURE_SECRET + ':' + message.params.arguments.text }] }
            : { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        }
      });
    `);
    const launcher = startLauncher('gmail', {
      NIMBALYST_KIMI_MCP_CONFIG: writeSessionFile({
        gmail: { type: 'stdio', command: process.execPath, args: [script], env: { FIXTURE_SECRET: 'from-session-file' } },
      }),
    });
    await launcher.handshake();
    expect((await launcher.request('tools/list')).result.tools).toEqual([TOOL]);
    const called = await launcher.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(called.result.content[0].text).toBe('from-session-file:hi');
  }, 20_000);

  it('bridges an SSE server, keeping the session query string and the bearer header', async () => {
    const seen: string[] = [];
    const streams = new Map<string, http.ServerResponse>();
    const port = await listen(http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      seen.push(`${req.method} ${url.pathname}${url.search} ${req.headers.authorization}`);
      if (req.headers.authorization !== 'Bearer app-token') { res.writeHead(401).end(); return; }
      if (req.method === 'GET') {
        const id = randomUUID();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: endpoint\ndata: /mcp/host/messages?stream=${id}\n\n`);
        streams.set(id, res);
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(202).end();
        const message = JSON.parse(body);
        if (message.id === undefined) return;
        streams.get(url.searchParams.get('stream')!)!
          .write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message, 'sse') })}\n\n`);
      });
    }));
    const launcher = startLauncher('nimbalyst-host', {
      NIMBALYST_KIMI_MCP_CONFIG: writeSessionFile({
        'nimbalyst-host': {
          type: 'sse',
          url: `http://127.0.0.1:${port}/mcp/host?workspacePath=C%3A%5Cwork&sessionId=nimbalyst-1`,
          headers: { Authorization: 'Bearer app-token' },
        },
      }),
    });
    await launcher.handshake();
    const called = await launcher.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(called.result.content[0].text).toBe('sse:hi');
    expect(seen[0]).toBe('GET /mcp/host?workspacePath=C%3A%5Cwork&sessionId=nimbalyst-1 Bearer app-token');
    expect(seen.filter((line) => line.startsWith('POST')).every((line) => line.endsWith('Bearer app-token'))).toBe(true);
  }, 20_000);

  it('bridges a streamable HTTP server and carries its session id forward', async () => {
    const sessionIds: Array<string | undefined> = [];
    const port = await listen(http.createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const message = JSON.parse(body);
        sessionIds.push(req.headers['mcp-session-id'] as string | undefined);
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'http-session-7' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message, `http ${req.headers['x-api-key']}`) }));
      });
    }));
    const launcher = startLauncher('docs', {
      NIMBALYST_KIMI_MCP_CONFIG: writeSessionFile({
        docs: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Api-Key': 'k1' } },
      }),
    });
    await launcher.handshake();
    const called = await launcher.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    expect(called.result.content[0].text).toBe('http k1:hi');
    expect(sessionIds[0]).toBeUndefined();
    expect(sessionIds.at(-1)).toBe('http-session-7');
  }, 20_000);
});
