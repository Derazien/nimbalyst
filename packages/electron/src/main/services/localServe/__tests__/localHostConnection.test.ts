// @vitest-environment node
/**
 * #416: a local headless host saved in Settings is what makes its sessions
 * appear. These cover the three things a user cannot see go wrong: an address
 * that would put the token on a LAN is refused, the token is never written in
 * plain text, and a saved host actually connects the desktop's local mirror
 * (and removing it disconnects).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

import { createLocalServeHost } from '@nimbalyst/runtime/sync/localServe/LocalServeHost';
import type { SyncProvider } from '@nimbalyst/runtime/sync/types';
import { validateLocalHostInput } from '../localHostSettings';
import { createLocalHostStore, type LocalHostBackingStore } from '../localHostStore';
import { createLocalHostConnection } from '../localHostConnection';

const TOKEN = 'k'.repeat(48);

function memoryStore(): LocalHostBackingStore & { raw: () => string } {
  let data: Record<string, unknown> = {};
  return {
    get: (key) => data[key] as never,
    set: (key, value) => { data = { ...data, [key]: value }; },
    delete: (key) => { const { [key]: _gone, ...rest } = data; data = rest; },
    raw: () => JSON.stringify(data),
  };
}

const reversible = { available: () => true, encrypt: (value: string) => Buffer.from(`enc:${value}`).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString().replace(/^enc:/, '') };

describe('local host settings', () => {
  it('accepts loopback and tailnet addresses and refuses everything else', () => {
    expect(validateLocalHostInput('http://127.0.0.1:47615', TOKEN)).toEqual({ ok: true, url: 'http://127.0.0.1:47615' });
    expect(validateLocalHostInput(' http://100.74.46.18:47615/ ', TOKEN)).toEqual({ ok: true, url: 'http://100.74.46.18:47615' });
    for (const url of ['http://192.168.1.10:47615', 'http://0.0.0.0:47615', 'http://example.com:47615', 'ftp://127.0.0.1:21', 'http://127.0.0.1', 'not a url']) {
      expect(validateLocalHostInput(url, TOKEN).ok).toBe(false);
    }
    expect(validateLocalHostInput('http://127.0.0.1:47615', 'short').ok).toBe(false);
  });

  it('stores the token encrypted, refuses to save without encryption, and forgets it on remove', () => {
    const backing = memoryStore();
    const store = createLocalHostStore(() => backing, reversible);
    store.save('http://127.0.0.1:47615', TOKEN);
    expect(backing.raw()).not.toContain(TOKEN);
    expect(store.read()).toEqual(expect.objectContaining({ url: 'http://127.0.0.1:47615' }));
    expect(store.readToken()).toBe(TOKEN);
    store.remove();
    expect(store.read()).toBeNull();
    expect(store.readToken()).toBeNull();

    const locked = createLocalHostStore(() => memoryStore(), { ...reversible, available: () => false });
    expect(() => locked.save('http://127.0.0.1:47615', TOKEN)).toThrow(/encrypt/i);
  });
});

describe('local host connection', () => {
  it('connects the local mirror to a saved host, reports it online, and disconnects on remove', async () => {
    const host = createLocalServeHost({
      host: '127.0.0.1', port: 0, token: TOKEN,
      device: { deviceId: 'node-1', name: 'Node on this machine', type: 'headless', platform: 'win32', connectedAt: 1, lastActiveAt: 1 },
      loadIndex: async () => [], loadMessages: async () => [],
    });
    const { port } = await host.listen();
    const backing = memoryStore();
    const store = createLocalHostStore(() => backing, reversible);
    const target = { setLocalProvider: vi.fn((_provider: SyncProvider | null, _key?: CryptoKey | null) => {}) };
    const connection = createLocalHostConnection({ store, target, localDeviceId: () => 'desktop-1' });

    try {
      expect(await connection.status()).toEqual(expect.objectContaining({ configured: false, online: false }));

      store.save(`http://127.0.0.1:${port}`, TOKEN);
      await connection.connect();
      const provider = target.setLocalProvider.mock.calls.at(-1)![0]!;
      expect(provider).not.toBeNull();
      for (let i = 0; i < 200 && !provider.isIndexReady?.(); i++) await new Promise(resolve => setTimeout(resolve, 25));
      expect(provider.getConnectedDevices?.()).toEqual([expect.objectContaining({ deviceId: 'node-1', isOnline: true })]);
      expect(await connection.status()).toEqual(expect.objectContaining({ configured: true, online: true, hostName: 'Node on this machine' }));

      // A wrong token is caught by the test call before anything is saved.
      expect(await connection.test(`http://127.0.0.1:${port}`, 'x'.repeat(48))).toEqual(expect.objectContaining({ ok: false }));
      expect(await connection.test(`http://127.0.0.1:${port}`, TOKEN)).toEqual(expect.objectContaining({ ok: true, hostName: 'Node on this machine' }));

      store.remove();
      await connection.connect();
      expect(target.setLocalProvider.mock.calls.at(-1)![0]).toBeNull();
      expect(provider.isIndexReady?.()).toBe(false);
    } finally {
      connection.disconnect();
      await host.close();
    }
  }, 30_000);
});
