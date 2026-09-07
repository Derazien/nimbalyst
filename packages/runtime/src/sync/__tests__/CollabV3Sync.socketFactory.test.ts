// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';
import { createCollabV3Sync } from '../CollabV3Sync';

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
});
