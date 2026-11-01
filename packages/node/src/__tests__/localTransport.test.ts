// @vitest-environment node
/**
 * The #416 gate, without a desktop restart: a session created on a headless
 * node over loopback is visible to a desktop-side client, streams its
 * transcript, takes a follow-up prompt that resumes the same provider session,
 * and is still there and still resumable after the node restarts.
 *
 * Real: serve's runtime and wiring, the SQLite database and migrations, the
 * HTTP transport on 127.0.0.1, the client the desktop's RemoteSessionMirror
 * reads. Fake: only the Claude turn, so no `claude` binary is spawned.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../host/nodeHost.js', () => ({ registerNodeHostEnvironment: vi.fn() }));
vi.mock('../host/claudeCodeDeps.js', () => ({ registerClaudeCodeDeps: vi.fn() }));

import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { createLocalServeClient, type LocalServeClient } from '@nimbalyst/runtime/sync/localServe/LocalServeClient';
import type { AgentMessage } from '@nimbalyst/runtime/ai/server/types';
import type { CreateSessionResponse, SessionChange } from '@nimbalyst/runtime/sync/types';

import { loadConfig } from '../config.js';
import type { NimbalystNode } from '../NimbalystNode.js';
import { serveLocal } from '../serve/startServeLocal.js';
import type { RunTurnInput } from '../serve/serveRuntime.js';

const TOKEN = 'a'.repeat(48);
const NODE_ID = 'node-loopback';

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface TurnSeen { sessionId: string; prompt: string; cwd: string; resumedFrom?: string }

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-local-serve-'));
  const projects = path.join(dir, 'projects');
  const project = path.join(projects, 'repo');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(dir, 'token'), TOKEN);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    databasePath: './node.sqlite',
    trust: { mode: 'bypass-all' },
    local: { host: '127.0.0.1', port: 0, tokenPath: './token', deviceId: NODE_ID, inPlaceRoots: [projects] },
  }));
  const turns: TurnSeen[] = [];
  const events: Array<[string, unknown]> = [];

  /** Stands in for a Claude turn: writes the transcript rows a real one writes, and a provider session id. */
  const runTurnOverride = async (node: NimbalystNode, input: RunTurnInput) => {
    const before = await node.store.get(input.sessionId);
    turns.push({ sessionId: input.sessionId, prompt: input.prompt, cwd: input.workspacePath, resumedFrom: before?.providerSessionId ?? undefined });
    input.onTurnStarted({ cancel: async () => {} });
    await AgentMessagesRepository.create({ sessionId: input.sessionId, source: 'claude-code', direction: 'input', content: JSON.stringify({ prompt: input.prompt }), createdAt: new Date() });
    await AgentMessagesRepository.create({ sessionId: input.sessionId, source: 'claude-code', direction: 'output', content: JSON.stringify({ type: 'text', text: `done: ${input.prompt}` }), createdAt: new Date() });
    if (!before?.providerSessionId) await node.sessionManager.updateProviderSessionData(input.sessionId, 'provider-1');
    return {};
  };

  const running: Array<{ stop: () => Promise<void> }> = [];
  async function start(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
    const controller = new AbortController();
    let resolveAddress!: (address: { host: string; port: number }) => void;
    const listening = new Promise<{ host: string; port: number }>((resolve) => { resolveAddress = resolve; });
    const done = serveLocal({ config: loadConfig(path.join(dir, 'config.json')), signal: controller.signal, log: (event, fields) => { events.push([event, fields]); }, onListening: resolveAddress, runTurnOverride });
    const address = await Promise.race([listening, done.then(() => { throw new Error('serve exited before listening'); })]);
    const handle = { stop: async () => { controller.abort(); await done; } };
    running.push(handle);
    return { baseUrl: `http://${address.host}:${address.port}`, stop: handle.stop };
  }

  function client(baseUrl: string): LocalServeClient {
    const c = createLocalServeClient({
      baseUrl,
      token: TOKEN,
      localDevice: { deviceId: 'desktop-1', name: 'Desktop', type: 'desktop', platform: 'win32', connectedAt: 1, lastActiveAt: 1 },
      reconnectDelayMs: 50,
    });
    c.start();
    return c;
  }

  return {
    dir, project, turns, events, start, client,
    async cleanup() {
      for (const handle of running.splice(0)) await handle.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

describe('serve over the local transport', () => {
  it('a session created on the node shows on the desktop side, streams, resumes, and survives a node restart', async () => {
    const f = fixture();
    cleanup = f.cleanup;
    const first = await f.start();
    const desktop = f.client(first.baseUrl);
    await desktop.ready();

    // The node announces itself as a headless host the desktop can target.
    expect(desktop.getConnectedDevices?.()).toEqual([expect.objectContaining({ deviceId: NODE_ID, type: 'headless', isOnline: true })]);

    // Create, exactly as RemoteSessionMirror.create sends it.
    const responses: CreateSessionResponse[] = [];
    desktop.onCreateSessionResponse?.((response) => responses.push(response));
    await desktop.sendCreateSessionRequest?.({ requestId: 'req-1', projectId: f.project, targetDeviceId: NODE_ID, provider: 'claude-code', initialPrompt: 'first', timestamp: Date.now() });
    const created = await until(() => responses.find((r) => r.requestId === 'req-1'), 'create-session response');
    expect(created).toEqual(expect.objectContaining({ success: true }));
    const sessionId = created.sessionId!;

    // It shows in the index, filed under the desktop's project and attributed to the node.
    const entry = await until(() => {
      const e = desktop.getCachedIndexEntry?.(sessionId);
      return e && e.messageCount >= 2 && e.isExecuting === false ? e : undefined;
    }, 'index entry after the first turn');
    expect(entry).toEqual(expect.objectContaining({ projectId: f.project, hostDeviceId: NODE_ID }));

    // The transcript streams: stored rows on connect, live rows after.
    const rows = new Map<number, AgentMessage>();
    desktop.onRemoteChange(sessionId, (change: SessionChange) => {
      if (change.type === 'message_added' && typeof change.message.id === 'number') rows.set(change.message.id, change.message);
    });
    await desktop.connect(sessionId);
    expect(rows.size).toBe(2);

    // A follow-up, queued the way the mirror queues it, drains on the node and resumes the provider session.
    const queued = await desktop.pushChange(sessionId, { type: 'metadata_updated', metadata: { queuedPrompts: [{ id: 'remote-1', prompt: 'second', timestamp: Date.now() }] } });
    expect(queued).toEqual(expect.objectContaining({ published: true }));
    await until(() => rows.size >= 4, 'live rows of the second turn').catch((error) => { console.log(JSON.stringify(f.events.slice(-25)), rows.size, f.turns); throw error; });
    expect(f.turns.map((t) => [t.prompt, t.resumedFrom])).toEqual([['first', undefined], ['second', 'provider-1']]);
    // Same machine: the agent ran in the desktop's own directory, no checkout.
    expect(new Set(f.turns.map((t) => t.cwd))).toEqual(new Set([realpathSync(f.project)]));
    await until(() => desktop.getCachedIndexEntry?.(sessionId)?.queuedPrompts?.length === 0 || undefined, 'queue drained');

    // The node restarts. Its database is the source of truth, so a desktop that
    // reconnects sees the same session and the whole transcript.
    desktop.close();
    await first.stop();
    const second = await f.start();
    const again = f.client(second.baseUrl);
    await again.ready();
    const index = await again.fetchIndex!();
    expect(index.sessions).toEqual([expect.objectContaining({ sessionId, projectId: f.project, hostDeviceId: NODE_ID, messageCount: 4 })]);
    // A restarted durable host must not look like a sandbox that lost its sessions.
    expect(again.getConnectedDevices?.()[0].connectedAt).toBeLessThanOrEqual(entry.createdAt);

    const replayed = new Map<number, AgentMessage>();
    again.onRemoteChange(sessionId, (change) => {
      if (change.type === 'message_added' && typeof change.message.id === 'number') replayed.set(change.message.id, change.message);
    });
    await again.connect(sessionId);
    expect([...replayed.keys()]).toEqual([...rows.keys()]);

    // And it resumes after the restart, still on the same provider session.
    await again.pushChange(sessionId, { type: 'metadata_updated', metadata: { queuedPrompts: [{ id: 'remote-2', prompt: 'third', timestamp: Date.now() }] } });
    await until(() => replayed.size >= 6, 'rows of the turn after the restart');
    expect(f.turns.at(-1)).toEqual(expect.objectContaining({ sessionId, prompt: 'third', resumedFrom: 'provider-1' }));
    again.close();
  }, 30_000);

  it('refuses a request whose token is wrong, and a project outside the in-place roots', async () => {
    const f = fixture();
    cleanup = f.cleanup;
    const { baseUrl } = await f.start();

    const denied = await fetch(`${baseUrl}/v0/index`, { headers: { authorization: `Bearer ${'b'.repeat(48)}` } });
    expect(denied.status).toBe(401);

    const desktop = f.client(baseUrl);
    await desktop.ready();
    const responses: CreateSessionResponse[] = [];
    desktop.onCreateSessionResponse?.((response) => responses.push(response));
    await desktop.sendCreateSessionRequest?.({ requestId: 'req-outside', projectId: os.tmpdir(), targetDeviceId: NODE_ID, initialPrompt: 'x', timestamp: Date.now() });
    const refused = await until(() => responses.find((r) => r.requestId === 'req-outside'), 'refusal');
    expect(refused).toEqual(expect.objectContaining({ success: false }));
    expect(f.turns).toEqual([]);
    desktop.close();
  }, 30_000);
});
