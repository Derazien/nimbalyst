#!/usr/bin/env node
'use strict';
/**
 * Stands in for one Nimbalyst MCP server inside a Kimi Code CLI session.
 *
 * The genuine `kimi` terminal app takes no MCP servers on its command line. It
 * reads them from ~/.kimi-code/mcp.json, one file for every kimi on the
 * machine, while Nimbalyst's servers are different per session: their address
 * carries the session id and a token that changes every app start. So that
 * file only ever holds `node kimiCliMcpLauncher.cjs <server name>`, with no
 * address and no secret in it, and this script finds the real server at the
 * moment kimi starts it: kimi hands its own environment to the servers it
 * starts, and Nimbalyst starts kimi with NIMBALYST_KIMI_MCP_CONFIG naming a
 * private file that holds this session's servers.
 *
 * A kimi that Nimbalyst did not start has no such variable, and a session in
 * another project may not have this server: both get a server with no tools
 * rather than an error in the person's own terminal.
 *
 * No dependencies and CommonJS on purpose: it ships as a loose file and runs
 * under whatever node is on PATH, or under Nimbalyst itself as node.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const CONFIG_ENV = 'NIMBALYST_KIMI_MCP_CONFIG';
const serverName = process.argv[2];

function readEntry() {
  const file = process.env[CONFIG_ENV];
  if (!file || !serverName) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[serverName];
    return entry && typeof entry === 'object' ? entry : null;
  } catch (error) {
    console.error(`[nimbalyst] cannot read ${file}: ${error.message}`);
    return null;
  }
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Tell kimi a request failed now, rather than leaving it to time out. */
function failRequest(message, reason) {
  console.error(`[nimbalyst] ${serverName}: ${reason}`);
  if (message && message.id !== undefined && message.method) {
    emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `${serverName}: ${reason}` } });
  }
}

/** kimi writes one JSON message per line. */
function onMessages(handle) {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch (error) {
        console.error(`[nimbalyst] ${serverName}: unreadable message from kimi: ${error.message}`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function serveEmpty() {
  onMessages((message) => {
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      emit({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: `nimbalyst-${serverName || 'mcp'}`, version: '1.0.0' },
        },
      });
    } else if (message.method === 'tools/list') {
      emit({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else if (message.method === 'ping') {
      emit({ jsonrpc: '2.0', id: message.id, result: {} });
    } else {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  });
}

/** A stdio server: run it on kimi's own pipes and get out of the way. */
function runStdio(entry) {
  const env = { ...process.env };
  // The session file lists every server's credentials; one server has no
  // business reading the others'. And a server is not Nimbalyst-as-node.
  delete env[CONFIG_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(entry.command, entry.args || [], {
    stdio: 'inherit',
    env: { ...env, ...(entry.env || {}) },
    cwd: entry.cwd || process.cwd(),
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(`[nimbalyst] ${serverName}: could not start ${entry.command}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  const stop = () => {
    try { child.kill(); } catch (_) { /* already gone */ }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('exit', stop);
}

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

/** Calls back with (event, data) for each server-sent event on `stream`. */
function readEvents(stream, onEvent) {
  let buffer = '';
  let event = 'message';
  let data = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line === '') {
        if (data.length > 0) onEvent(event, data.join('\n'));
        event = 'message';
        data = [];
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  });
}

function emitRaw(text) {
  try {
    emit(JSON.parse(text));
  } catch (error) {
    console.error(`[nimbalyst] ${serverName}: unreadable message from the server: ${error.message}`);
  }
}

/** The older HTTP+SSE transport, which is what Nimbalyst's own servers speak. */
function bridgeSse(entry, alreadyReceived) {
  const base = new URL(entry.url);
  const headers = entry.headers || {};
  const waiting = alreadyReceived.slice();
  let endpoint = null;

  const post = (message) => {
    const body = JSON.stringify(message);
    const request = clientFor(endpoint).request(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      if (response.statusCode >= 400) failRequest(message, `the server answered HTTP ${response.statusCode}`);
    });
    request.on('error', (error) => failRequest(message, error.message));
    request.end(body);
  };

  const connect = clientFor(base).request(base, {
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
  }, (response) => {
    if (response.statusCode !== 200) {
      console.error(`[nimbalyst] ${serverName}: the server answered HTTP ${response.statusCode}`);
      process.exit(1);
    }
    readEvents(response, (event, data) => {
      if (event === 'endpoint') {
        endpoint = new URL(data, base);
        while (waiting.length > 0) post(waiting.shift());
      } else if (event === 'message') {
        emitRaw(data);
      }
    });
    response.on('end', () => process.exit(1));
    response.on('error', () => process.exit(1));
  });
  connect.on('error', (error) => {
    console.error(`[nimbalyst] ${serverName}: cannot reach ${base.origin}: ${error.message}`);
    process.exit(1);
  });
  connect.end();

  return (message) => (endpoint ? post(message) : waiting.push(message));
}

/** Streamable HTTP, falling back to SSE when the server turns the first POST down. */
function bridgeHttp(entry) {
  const url = new URL(entry.url);
  const headers = entry.headers || {};
  let sessionId = null;
  let first = true;
  let viaSse = null;

  return function send(message) {
    if (viaSse) return viaSse(message);
    const body = JSON.stringify(message);
    const wasFirst = first;
    first = false;
    const request = clientFor(url).request(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
    }, (response) => {
      if (response.headers['mcp-session-id']) sessionId = String(response.headers['mcp-session-id']);
      const status = response.statusCode;
      if (wasFirst && (status === 400 || status === 404 || status === 405)) {
        response.resume();
        viaSse = bridgeSse(entry, [message]);
        return;
      }
      if (status >= 400) {
        response.resume();
        failRequest(message, `the server answered HTTP ${status}`);
        return;
      }
      if (String(response.headers['content-type'] || '').includes('text/event-stream')) {
        readEvents(response, (event, data) => {
          if (event === 'message') emitRaw(data);
        });
        return;
      }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (text.trim()) emitRaw(text);
      });
    });
    request.on('error', (error) => failRequest(message, error.message));
    request.end(body);
  };
}

const entry = readEntry();
if (!entry) {
  serveEmpty();
} else if (typeof entry.command === 'string' && entry.command) {
  runStdio(entry);
} else if (typeof entry.url === 'string' && entry.url) {
  const transport = String(entry.type || entry.transport || 'http').toLowerCase();
  onMessages(transport === 'sse' ? bridgeSse(entry, []) : bridgeHttp(entry));
} else {
  console.error(`[nimbalyst] ${serverName}: the session file has neither a command nor a url for it`);
  serveEmpty();
}
