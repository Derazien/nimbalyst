// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSessionMirror } from '../RemoteSessionMirror';
import type { SessionChange, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { logger } from '../../../utils/logger';
import type { RemoteSessionSnapshot } from '../RemoteSessionMirror';
import type { AgentMessage } from '@nimbalyst/runtime/ai/server/types';
import { createLocalServeHost } from '@nimbalyst/runtime/sync/localServe/LocalServeHost';
import { createLocalServeClient } from '@nimbalyst/runtime/sync/localServe/LocalServeClient';
import { deriveLocalServeKey } from '@nimbalyst/runtime/sync/localServe/protocol';

function fixture() {
  const entry = { sessionId: 'remote', hostDeviceId: 'sandbox-1', projectId: '/repo', title: 'Remote test', provider: 'claude-code', messageCount: 0, createdAt: 100, updatedAt: 200, lastMessageAt: 200 };
  let changes: ((change: SessionChange) => void) | undefined;
  let status: (() => void) | undefined;
  let index: ((id: string) => void) | undefined;
  const offChange = vi.fn(); const offStatus = vi.fn();
  const provider = {
    fetchIndex: vi.fn(async () => ({ sessions: [entry], projects: [] })),
    getCachedIndexEntry: vi.fn(() => entry),
    getLocalDeviceInfo: () => ({ deviceId: 'desktop' }),
    getConnectedDevices: vi.fn(() => [{ deviceId: 'sandbox-1', isOnline: true }]),
    getStatus: () => ({ connected: true, syncing: false }),
    onIndexChange: (cb: typeof index) => { index = cb; return vi.fn(); },
    onRemoteChange: vi.fn((_id, cb) => { changes = cb; return offChange; }),
    onStatusChange: vi.fn((_id, cb) => { status = cb; return offStatus; }),
    connect: vi.fn(async () => {}), disconnect: vi.fn(),
    pushChange: vi.fn(async (_id: string, _change: SessionChange) => ({ published: true })), sendSessionControlMessage: vi.fn(async () => {}),
  };
  const deps = { localSessionIds: vi.fn(async () => new Set<string>()), hasLocalSession: vi.fn(async () => false), listChanged: vi.fn() };
  const mirror = new RemoteSessionMirror(deps);
  mirror.setProvider(provider as unknown as SyncProvider);
  return { mirror, entry, deps, provider, offChange, offStatus,
    change: (change: SessionChange) => changes?.(change), status: () => status?.(), index: () => index?.('remote') };
}

afterEach(() => vi.useRealTimers());
describe('remote desktop mirrors', () => {
  it('counts descendants recursively without crossing workspace or host boundaries', async () => {
    const f = fixture();
    f.provider.fetchIndex.mockResolvedValue({ sessions: [f.entry,
      { ...f.entry, sessionId: 'child', parentSessionId: 'remote' },
      { ...f.entry, sessionId: 'leaf', parentSessionId: 'child' },
      { ...f.entry, sessionId: 'foreign', parentSessionId: 'remote', hostDeviceId: 'sandbox-2' },
    ], projects: [] } as any);
    const rows = await f.mirror.list('/repo', []);
    expect(rows.find(row => row.id === 'remote')).toMatchObject({ childCount: 1, descendantCount: 2 });
    expect(rows.find(row => row.id === 'child')).toMatchObject({ childCount: 1, descendantCount: 1 });
  });
  it.each([true, false])('logs the provider reason and retains the user-facing queue failure (retryable=%s)', async (retryable) => {
    const f = fixture();
    const warn = vi.spyOn(logger.main, 'warn').mockImplementation(() => {});
    try {
      f.provider.pushChange.mockResolvedValueOnce({ published: false, retryable, reason: 'remote queue disconnected' } as never);
      await expect(f.mirror.queue('remote', '/repo', 'prompt')).rejects.toThrow('The prompt could not be sent');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/session remote: remote queue disconnected/));
    } finally { warn.mockRestore(); }
  });
  it('reconnects an observed transcript before queueing after an idle socket expires', async () => {
    const f = fixture();
    const stop = await f.mirror.watch('remote', '/repo', vi.fn());
    f.provider.getStatus = () => ({connected: false, syncing: false});
    await f.mirror.queue('remote', '/repo', 'first turn after idle');
    expect(f.provider.connect).toHaveBeenCalledTimes(2);
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('serializes submissions while the preceding queue publication is in flight', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.provider.pushChange.mockImplementation(async (_id: string, change: any) => {
      await gate;
      Object.assign(f.entry, {queuedPrompts: change.metadata.queuedPrompts});
      return {published: true};
    });
    const first = f.mirror.queue('remote', '/repo', 'first');
    const second = f.mirror.queue('remote', '/repo', 'second');
    await vi.waitFor(() => expect(f.provider.pushChange).toHaveBeenCalled());
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect((f.entry as any).queuedPrompts.map((row: any) => row.prompt)).toEqual(['first', 'second']);
  });

  it('merges remote metadata only in its workspace, with local collisions taking precedence', async () => {
    const f = fixture();
    expect(await f.mirror.list('/other', [])).toEqual([]);
    expect(await f.mirror.list('/repo', [])).toEqual([expect.objectContaining({ id: 'remote', remoteHostDeviceId: 'sandbox-1', workspaceId: '/repo' })]);
    f.deps.hasLocalSession.mockResolvedValue(true);
    f.deps.localSessionIds.mockResolvedValue(new Set(['remote']));
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    expect(await f.mirror.get('remote', '/repo')).toBeNull();
    await expect(f.mirror.watch('remote', '/repo', vi.fn())).rejects.toThrow('not available');
    expect(f.provider.connect).not.toHaveBeenCalled();
  });

  it('subscribes before connect, renders real canonical messages, deduplicates replay and releases the last viewer', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.connect.mockImplementation(async () => {
      f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'Read only, please', createdAt: new Date(100) } });
    });
    const stop = await f.mirror.watch('remote', '/repo', received);
    const stop2 = await f.mirror.watch('remote', '/repo', vi.fn());
    f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'duplicate', createdAt: new Date(100) } });
    await vi.advanceTimersByTimeAsync(200);
    expect(received).toHaveBeenCalled();
    const snapshot = received.mock.lastCall![0];
    expect(snapshot.session.messages).toHaveLength(1);
    expect(JSON.stringify(snapshot.session.messages)).toContain('Read only, please');
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
    stop(); expect(f.provider.disconnect).not.toHaveBeenCalled();
    stop2(); expect(f.provider.disconnect).toHaveBeenCalledWith('remote');
    expect(f.offChange).toHaveBeenCalled(); expect(f.offStatus).toHaveBeenCalled();
    f.mirror.setProvider(null);
  });

  it('rejects workspace mismatches and sends queue/cancel only to the owning host', async () => {
    const f = fixture();
    await expect(f.mirror.queue('remote', '/other', 'hello')).rejects.toThrow('not available');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    Object.assign(f.entry, { queuedPrompts: [{ id: 'existing', prompt: 'first', timestamp: 1 }] });
    const sent = await f.mirror.queue('remote', '/repo', 'second');
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', { type: 'metadata_updated', metadata: { queuedPrompts: [
      { id: 'existing', prompt: 'first', timestamp: 1 }, expect.objectContaining({ id: sent.promptId, prompt: 'second' }),
    ] } });
    await f.mirror.cancel('remote', '/repo');
    expect(f.provider.sendSessionControlMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'remote', targetDeviceId: 'sandbox-1', type: 'cancel' }));
    f.provider.getConnectedDevices.mockReturnValue([]);
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('offline');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('publishes encrypted attachments only after encryption and rejects an account change during staging', async () => {
    const f = fixture();
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    const encrypted = [{id: 'file', filename: 'f.png', mimeType: 'image/png', encryptedData: 'cipher', iv: 'nonce', size: 5}];
    const encryptAttachments = vi.fn(async () => encrypted);
    Object.assign(f.deps, {encryptAttachments});
    f.mirror.setProvider(f.provider as unknown as SyncProvider, key);
    const attachments = [{id: 'file', filename: 'f.png', filepath: '/staged/f.png', mimeType: 'image/png', size: 5, type: 'image' as const, addedAt: 1}];
    await f.mirror.queue('remote', '/repo', 'read it', attachments);
    expect(encryptAttachments).toHaveBeenCalledWith(attachments, '/repo', key);
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', expect.objectContaining({metadata: {queuedPrompts: [expect.objectContaining({attachments: encrypted})]}}));
    encryptAttachments.mockImplementation(async () => {f.mirror.setProvider(null); return encrypted;});
    await expect(f.mirror.queue('remote', '/repo', 'retain this', attachments)).rejects.toThrow('sync changed');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('keeps history readable but rejects controls after the ephemeral host restarts', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.getConnectedDevices.mockReturnValue([{ deviceId: 'sandbox-1', isOnline: true, type: 'headless', connectedAt: 150 }] as any);
    const stop = await f.mirror.watch('remote', '/repo', received);
    await vi.advanceTimersByTimeAsync(200);
    expect(received.mock.lastCall![0].readOnlyReason).toContain('restarted');
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('restarted');
    await expect(f.mirror.cancel('remote', '/repo')).rejects.toThrow('restarted');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    expect(f.provider.sendSessionControlMessage).not.toHaveBeenCalled();
    stop();
  });

  it('clears transcript content on account change and rejects a stale in-flight authorization', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    await f.mirror.watch('remote', '/repo', received);
    f.mirror.setProvider(null);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ connected: false, session: expect.objectContaining({ messages: [] }) }));
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    await expect(f.mirror.queue('remote', '/repo', 'hello')).rejects.toThrow('not available');
    const second = fixture();
    let release!: (value: boolean) => void;
    second.deps.hasLocalSession.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = second.mirror.queue('remote', '/repo', 'must not send');
    await vi.advanceTimersByTimeAsync(0);
    second.mirror.setProvider(null); release(false);
    await expect(pending).rejects.toThrow('sync changed');
    expect(second.provider.pushChange).not.toHaveBeenCalled();
  });
});

it('omits stale unrelated desktops while retaining remote project history and excluding locally owned history', async () => {
  const f = fixture();
  f.provider.getConnectedDevices.mockReturnValue([
    {deviceId: 'old-desktop', name: 'This Mac before rename', type: 'desktop', isOnline: false},
    {deviceId: 'other-live', name: 'Second directory', type: 'desktop'},
    {deviceId: 'sandbox-1', name: 'Sandbox', type: 'headless', isOnline: false},
  ] as any);
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['other-live', 'sandbox-1']);
  f.deps.hasLocalSession.mockResolvedValue(true);
    f.deps.localSessionIds.mockResolvedValue(new Set(['remote']));
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['other-live']);
});

it('keeps a configured sleeping sandbox but suppresses hidden history without making it locally executable', async () => {
  const f = fixture();
  Object.assign(f.deps, {configuredHostIds: () => new Set(['sandbox-1'])});
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'sandbox-1', type: 'headless', isOnline: false, inventoryHidden: false}] as any);
  expect((await f.mirror.hosts('/unrelated')).map(d => d.deviceId)).toEqual(['sandbox-1']);
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'sandbox-1', type: 'headless', isOnline: false, inventoryHidden: true}] as any);
  expect(await f.mirror.hosts('/repo')).toEqual([]);
  expect(await f.mirror.list('/repo', [])).toHaveLength(1);
  await expect(f.mirror.assertLocalExecution('remote')).rejects.toThrow('host');
});

it('keeps desktop history readable after its presence record expires and inventory metadata survives', async () => {
  const f = fixture();
  f.entry.hostDeviceId = 'retired-desktop';
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'retired-desktop', name: 'Previous installation', type: 'unknown', isOnline: false, inventoryHidden: true}] as any);
  expect(await f.mirror.list('/repo', [])).toHaveLength(1);
  expect(await f.mirror.hosts('/repo')).toEqual([]);
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'retired-desktop', name: 'Previous installation', type: 'unknown', isOnline: false, inventoryHidden: false}] as any);
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['retired-desktop']);
  await expect(f.mirror.assertLocalExecution('remote')).rejects.toThrow('host');
});

// #416: the desktop's real mirror, reading a headless node over the local
// transport (real HTTP on loopback, real client, real host). The node itself is
// a stand-in that answers the way serve's runtime does; the node package's
// localTransport test covers the real runtime on the other side of this wire.
describe('remote session mirror over the local serve transport', () => {
  it('lists, streams, queues into and creates a node-hosted session, and keeps working across a node restart', async () => {
    const token = 't'.repeat(48);
    const stored = new Map<string, AgentMessage[]>();
    const device = { deviceId: 'node-1', name: 'Node', type: 'headless' as const, platform: 'win32', connectedAt: 1, lastActiveAt: 1 };

    function startHost(port: number, seed: Array<NonNullable<ReturnType<NonNullable<SyncProvider['getCachedIndexEntry']>>>> = []) {
      const host = createLocalServeHost({ host: '127.0.0.1', port, token, device, loadIndex: async () => seed as any, loadMessages: async (id) => stored.get(id) ?? [] });
      const write = async (sessionId: string, prompt: string) => {
        const message: AgentMessage = { id: 0, sessionId, source: 'user', direction: 'input', content: prompt, createdAt: new Date() };
        stored.get(sessionId)!.push(message);
        await host.pushChange(sessionId, { type: 'message_added', message });
      };
      host.onCreateSessionRequest!(async (request) => {
        stored.set('hosted-1', []);
        await host.syncSessionsToIndex!([{ id: 'hosted-1', title: 'Hosted', provider: 'claude-code', hostDeviceId: 'node-1', workspaceId: request.projectId, messageCount: 0, createdAt: 10, updatedAt: 10 }]);
        await host.sendCreateSessionResponse!({ requestId: request.requestId, success: true, sessionId: 'hosted-1' });
        if (request.initialPrompt) await write('hosted-1', request.initialPrompt);
      });
      host.onIndexChange!((sessionId, entry) => {
        void (async () => {
          for (const prompt of entry.queuedPrompts ?? []) await write(sessionId, prompt.prompt);
          await host.pushChange(sessionId, { type: 'metadata_updated', metadata: { queuedPrompts: [] } });
        })();
      });
      return host;
    }

    let host = startHost(0);
    const { port } = await host.listen();
    const client = createLocalServeClient({ baseUrl: `http://127.0.0.1:${port}`, token, reconnectDelayMs: 50, localDevice: { deviceId: 'desktop', name: 'Desktop', type: 'desktop', platform: 'win32', connectedAt: 1, lastActiveAt: 1 } });
    client.start();
    await client.ready();
    const deps = { localSessionIds: vi.fn(async () => new Set<string>()), hasLocalSession: vi.fn(async () => false), listChanged: vi.fn() };
    const mirror = new RemoteSessionMirror(deps);
    mirror.setProvider(client, await deriveLocalServeKey(token));
    const settle = async (check: () => boolean, what: string) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!check()) throw new Error(`timed out: ${what}`);
    };

    try {
      expect((await mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['node-1']);
      const sessionId = await mirror.create('/repo', 'node-1', { prompt: 'first prompt' });
      expect(sessionId).toBe('hosted-1');
      expect(await mirror.list('/repo', [])).toEqual([expect.objectContaining({ id: 'hosted-1', remoteHostDeviceId: 'node-1' })]);

      const snapshots: RemoteSessionSnapshot[] = [];
      const off = await mirror.watch(sessionId, '/repo', snapshot => snapshots.push(snapshot));
      const latest = () => JSON.stringify(snapshots.at(-1)?.session.messages ?? []);
      await settle(() => latest().includes('first prompt'), 'initial prompt in the transcript');
      expect(snapshots.at(-1)).toEqual(expect.objectContaining({ connected: true, hostOnline: true, readOnlyReason: undefined }));

      await mirror.queue(sessionId, '/repo', 'second prompt');
      await settle(() => latest().includes('second prompt'), 'queued prompt reaching the node');

      // The node restarts on the same port; the client reconnects by itself.
      const seed = [host.getCachedIndexEntry!('hosted-1')!];
      await host.close();
      await settle(() => !client.isIndexReady!(), 'client noticing the node went away');
      host = startHost(port, seed);
      await host.listen();
      await settle(() => client.isIndexReady!(), 'client reconnecting');

      await mirror.queue(sessionId, '/repo', 'third prompt');
      await settle(() => latest().includes('third prompt'), 'prompt after the node restart');
      const rows = JSON.parse(latest()) as unknown[];
      expect(rows).toHaveLength(3);
      off();
    } finally {
      client.close();
      await host.close();
    }
  }, 30_000);
});
