// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';
import { createCollabV3Sync } from '../CollabV3Sync';
import type { CreateSessionRequest } from '../types';

/**
 * `SyncConfig.createWebSocket` exists so a host without a usable global
 * `WebSocket` -- the headless Node host, or the desktop renderer, which must
 * proxy sockets through main because the collab server rejects a browser
 * `Origin` -- can still drive this provider.
 *
 * The seam is only real if *every* socket goes through it, so the first test
 * deletes the global entirely: any construction site still reaching for
 * `new WebSocket(...)` throws `ReferenceError` instead of quietly working on a
 * machine that happens to have one.
 */

class FakeWebSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  });

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function baseConfig() {
  return {
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    personalMemberId: asPersonalMemberId('user-1'),
    getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    deviceInfo: {
      deviceId: 'desktop-1',
      name: 'MacBook Pro',
      type: 'desktop' as const,
      platform: 'macos',
      connectedAt: 0,
      lastActiveAt: 0,
    },
  };
}

describe('SyncConfig.createWebSocket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renews a node session socket whose original credential expired even while it still reports OPEN', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let token = nodeTokenFor('user-1', Math.floor(now / 1000) + 900);
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({...baseConfig(), getJwt: async () => asPersonalJwt(token), createWebSocket: url => {
      const socket = new FakeWebSocket(url); sockets.push(socket); return socket as unknown as WebSocket;
    }});
    const changes = vi.fn();
    const off = provider.onRemoteChange('idle', changes);
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1)); sockets[0].open();
      const opening = provider.connect('idle');
      await vi.waitFor(() => expect(sockets).toHaveLength(2)); sockets[1].open(); await opening;
      clock.mockReturnValue(now + 901_000);
      token = nodeTokenFor('user-1');
      expect(sockets[1].readyState).toBe(1);
      expect(provider.isConnected('idle')).toBe(false);
      const renewing = provider.connect('idle');
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      expect(sockets[1].close).toHaveBeenCalled();
      expect(new URL(sockets[2].url).searchParams.get('token')).toBe(token);
      sockets[2].open(); await renewing;
      expect(provider.isConnected('idle')).toBe(true);
    } finally {off(); provider.disconnectAll();}
  });

  it('shares an in-flight session connection and keeps pre-connect listeners across reconnects', async () => {
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({ ...baseConfig(), createWebSocket: url => {
      const socket = new FakeWebSocket(url); if (!url.includes(':index?')) sockets.push(socket); return socket as unknown as WebSocket;
    } });
    const statuses = vi.fn();
    const unsubscribe = provider.onStatusChange('remote-session', statuses);
    let opened = 0;
    const first = provider.connect('remote-session').then(() => opened++);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const second = provider.connect('remote-session').then(() => opened++);
    await Promise.resolve(); await Promise.resolve();
    expect(opened).toBe(0);
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await Promise.all([first, second]);
    expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    provider.disconnect('remote-session');
    statuses.mockClear();
    const next = provider.connect('remote-session');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].open(); await next;
    expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    unsubscribe(); provider.disconnectAll();
  });

  it('preserves opaque wire identities and uses server sequence for remote message IDs', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({ ...baseConfig(), encryptionKey: key, createWebSocket: url => {
      const socket = new FakeWebSocket(url); sockets.push(socket); return socket as unknown as WebSocket;
    } });
    const messages: any[] = [];
    const off = provider.onRemoteChange('remote', change => { if (change.type === 'message_added') messages.push(change.message); });
    const pending = provider.connect('remote');
    await vi.waitFor(() => expect(sockets.some(socket => socket.url.includes(':session:remote?'))).toBe(true));
    const socket = sockets.find(socket => socket.url.includes(':session:remote?'))!;
    socket.open(); await pending;
    const encryptedMessages = await Promise.all(['abcdef0123', 'abc9876543'].map(async (id, index) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ content: `message ${index}` })));
      return { id, sequence: index + 1, createdAt: 100 + index, source: 'user', direction: 'input', iv: Buffer.from(iv).toString('base64'), encryptedContent: Buffer.from(encrypted).toString('base64') };
    }));
    // A row from a prior personal-key epoch, or one the server blanked when
    // chunked rows were retired, can never decrypt; it must not hold the
    // readable rows or the next page hostage.
    const priorEpoch = { ...encryptedMessages[0], id: 'old0000000', sequence: 3, encryptedContent: Buffer.from('not ciphertext').toString('base64') };
    const blanked = { ...encryptedMessages[1], id: 'blank00000', sequence: 4, encryptedContent: '', iv: '' };
    socket.onmessage?.({ data: JSON.stringify({ type: 'syncResponse', messages: [...encryptedMessages, priorEpoch, blanked], hasMore: true, cursor: '4' }) } as MessageEvent);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages.map(message => [message.id, message.providerMessageId])).toEqual([[1, 'abcdef0123'], [2, 'abc9876543']]);
    await vi.waitFor(() => expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual({ type: 'syncRequest', sinceSeq: 4 }));
    off(); provider.disconnectAll();
  });

  it('uses a personal node access token unchanged for index and session connections', async () => {
    const token = nodeTokenFor('user-1');
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({
      ...baseConfig(),
      getJwt: async () => asPersonalJwt(token),
      createWebSocket: url => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0].open();
      const connecting = provider.connect('node-session');
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1].open();
      await connecting;
      for (const socket of sockets) {
        expect(new URL(socket.url).searchParams.get('token')).toBe(token);
      }
    } finally {
      provider.disconnectAll();
    }
  });

  it('exposes a connection generation that moves when the index socket is replaced', async () => {
    // The headless node binds a create-session claim to this value. The server
    // accepts a response only on the socket that received the broadcast, and
    // `isIndexReady()` cannot answer the question -- a disconnect and reconnect
    // that both complete between two reads looks like "never left".
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({
      ...baseConfig(),
      createWebSocket: url => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    const readiness = vi.fn();
    const off = provider.onIndexReadyChange!(readiness);
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0].open();
      await provider.waitForIndexReady!();
      expect(readiness).toHaveBeenLastCalledWith(true);

      const claimed = provider.getConnectionGeneration!();
      // Stable while nothing happens: a counter that drifts on its own would
      // make every claim look lost.
      expect(provider.getConnectionGeneration!()).toBe(claimed);

      // What the twelve-minute credential rotation does.
      await provider.reconnectIndex!();
      expect(provider.getConnectionGeneration!()).toBeGreaterThan(claimed);
      expect(readiness.mock.calls.map(([ready]) => ready)).toEqual([true, false]);
      sockets.at(-1)!.open();
      await provider.waitForIndexReady!();
      expect(readiness.mock.calls.map(([ready]) => ready)).toEqual([true, false, true]);
    } finally {
      off();
      provider.disconnectAll();
    }
  });

  it('stamps a create-session request with the generation at RECEIPT, not after decryption', async () => {
    // Decryption is asynchronous, so a disconnect lands in the middle of it. A
    // listener that samples the generation when the request is delivered reads
    // the socket that exists BY THEN and concludes it still holds a claim the
    // server has already released.
    const sockets: FakeWebSocket[] = [];
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );

    const delivered: CreateSessionRequest[] = [];
    const provider = createCollabV3Sync({
      ...baseConfig(),
      encryptionKey,
      createWebSocket: url => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      provider.onCreateSessionRequest!(request => { delivered.push(request); });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0].open();
      const atReceipt = provider.getConnectionGeneration!();

      // Ciphertext this key cannot open, so the decrypt path is exercised (and
      // awaited) without needing a matching encrypt.
      sockets[0].onmessage?.({
        data: JSON.stringify({
          type: 'createSessionRequestBroadcast',
          targetDeviceId: 'desktop-1',
          request: {
            requestId: 'req-1',
            encryptedProjectId: 'not-openable',
            projectIdIv: 'nonsense',
            timestamp: 1,
          },
        }),
      } as MessageEvent);

      // The socket goes away while that decrypt is still pending.
      sockets[0].close();

      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(provider.getConnectionGeneration!()).toBeGreaterThan(atReceipt);
      expect(delivered[0].receiptGeneration).toBe(atReceipt);
    } finally {
      provider.disconnectAll();
    }
  });

  it('blocks a wrong-sub node token with AUTH_MISMATCH before opening any socket', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const createWebSocket = vi.fn();
    const provider = createCollabV3Sync({
      ...baseConfig(),
      getJwt: async () => asPersonalJwt(nodeTokenFor('other-user')),
      createWebSocket,
    });
    try {
      await expect(provider.connect('node-session')).rejects.toMatchObject({ code: 'AUTH_MISMATCH' });
      expect(createWebSocket).not.toHaveBeenCalled();
    } finally {
      provider.disconnectAll();
    }
  });

  it('rejects an expired node token using UNIX seconds before opening any socket', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const createWebSocket = vi.fn();
    const provider = createCollabV3Sync({
      ...baseConfig(),
      getJwt: async () => asPersonalJwt(nodeTokenFor('user-1', Math.floor(Date.now() / 1000) - 1)),
      createWebSocket,
    });
    try {
      await expect(provider.connect('node-session')).rejects.toThrow('expired');
      expect(createWebSocket).not.toHaveBeenCalled();
    } finally {
      provider.disconnectAll();
    }
  });

  it('opens the index and session rooms through the factory with no global WebSocket', async () => {
    vi.stubGlobal('WebSocket', undefined);

    const sockets: FakeWebSocket[] = [];
    const createWebSocket = vi.fn((url: string) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    });

    const provider = createCollabV3Sync({ ...baseConfig(), createWebSocket });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toContain('/sync/');
    sockets[0].open();

    // The second construction site: a per-session room connection. `connect`
    // only resolves once the socket opens, so open it before awaiting.
    const connecting = provider.connect('session-1');
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    expect(sockets[1].url).toContain('session-1');
    sockets[1].open();
    await connecting;

    provider.disconnectAll();
  });

  it('keeps announcing the device after an identity read fails inside the timer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sockets: FakeWebSocket[] = [];
    let identityReadable = false;
    const getDeviceInfo = vi.fn(() => {
      if (!identityReadable) {
        throw Object.assign(new Error("EMFILE: too many open files, open 'computer-identity'"), { code: 'EMFILE' });
      }
      return { ...baseConfig().deviceInfo, lastActiveAt: 7 };
    });
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
      getDeviceInfo,
      createWebSocket: url => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const announces = () => sockets[0].send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter(message => message.type === 'deviceAnnounce');

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      // Only the announce timer is faked; waitFor and the sync paths keep real timers.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      // The first announce runs inside onopen, the rest inside the 30 s timer.
      expect(() => sockets[0].open()).not.toThrow();
      expect(announces()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMFILE'));

      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      expect(announces()).toHaveLength(0);

      identityReadable = true;
      vi.advanceTimersByTime(30_000);
      expect(announces()).toEqual([
        { type: 'deviceAnnounce', device: expect.objectContaining({ deviceId: 'desktop-1', lastActiveAt: 7 }) },
      ]);
    } finally {
      provider.disconnectAll();
      vi.useRealTimers();
    }
  });

  it('falls back to the global constructor when no factory is supplied', async () => {
    const constructed: FakeWebSocket[] = [];
    class TrackedWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        constructed.push(this);
      }
    }
    vi.stubGlobal('WebSocket', TrackedWebSocket);

    const provider = createCollabV3Sync(baseConfig());

    await vi.waitFor(() => expect(constructed).toHaveLength(1));
    constructed[0].open();

    provider.disconnectAll();
  });

  it('logs a dropped session socket as one line that never contains the room URL or token', async () => {
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({ ...baseConfig(), createWebSocket: url => {
      const socket = new FakeWebSocket(url); sockets.push(socket); return socket as unknown as WebSocket;
    } });
    const lines: string[] = [];
    const record = (...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1)); sockets[0].open();
      const connecting = provider.connect('dropped');
      await vi.waitFor(() => expect(sockets).toHaveLength(2)); sockets[1].open(); await connecting;
      lines.length = 0;

      // Server- and runtime-provided text is never copied: not a URL, not a bare bearer token, not a title.
      const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0.c2lnbmF0dXJl';
      const title = 'Q3 layoffs plan for Acme';
      const errorEvent = Object.assign(new Event('error'), { message: `connect failed for ${sockets[1].url} with ${bearer}` });
      sockets[1].onerror?.(errorEvent);
      sockets[1].onclose?.({ code: 1006, reason: `${bearer} rejected: ${title}`, wasClean: false } as CloseEvent);

      const mentions = lines.filter(line => line.includes('dropped'));
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatch(/code=1006 \(abnormal closure\).*reasonLength=\d+.*wasClean=false.*reachedOpen=true.*openFor=\d+ms.*error=other/);
      expect(mentions[0]).toContain('reconnect on the next write or index reconnect');
      const logged = lines.join('\n');
      expect(logged).not.toMatch(/token|wss:\/\/|Bearer|eyJ|c2VjcmV0|layoffs|Acme/);
    } finally { provider.disconnectAll(); }
  });
});

function nodeTokenFor(sub: string, exp = Math.floor(Date.now() / 1000) + 900): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1, sub, org: 'org-1', scope: 'personal', nid: 'node-1', iat: exp - 900, exp,
  })).toString('base64url');
  return `nimnode_v1~test-key~${payload}~c2lnbmF0dXJl`;
}
