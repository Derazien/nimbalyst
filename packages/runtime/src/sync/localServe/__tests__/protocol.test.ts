// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createLocalServeEventParser,
  encodeLocalServeEvent,
  isAllowedLocalServeBindAddress,
} from '../protocol';
import { createLocalServeHost } from '../LocalServeHost';

describe('local serve bind addresses', () => {
  it('accepts loopback and the tailnet ranges only', () => {
    for (const ok of ['127.0.0.1', '127.8.9.10', 'localhost', '::1', '[::1]', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1']) {
      expect(isAllowedLocalServeBindAddress(ok)).toBe(true);
    }
    // Every interface, a LAN, the CGNAT edges outside Tailscale's /10, and garbage.
    for (const refused of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', '100.63.255.255', '100.128.0.1', 'fd7a:115c:a1e1::1', '256.0.0.1', 'example.com', '']) {
      expect(isAllowedLocalServeBindAddress(refused)).toBe(false);
    }
  });

  it('refuses to construct a host on a disallowed address or without a token', () => {
    const base = { port: 0, device: { deviceId: 'n', name: 'n', type: 'headless' as const, platform: 'x', connectedAt: 0, lastActiveAt: 0 }, loadIndex: async () => [], loadMessages: async () => [] };
    expect(() => createLocalServeHost({ ...base, host: '0.0.0.0', token: 'x'.repeat(40) })).toThrow(/refusing to listen/);
    expect(() => createLocalServeHost({ ...base, host: '127.0.0.1', token: '' })).toThrow(/token/);
  });
});

describe('local serve event stream parsing', () => {
  it('reassembles events split across chunks and skips heartbeats and bad frames', () => {
    const parse = createLocalServeEventParser();
    const frame = encodeLocalServeEvent({ type: 'indexRemoved', sessionId: 's1' });
    const cut = Math.floor(frame.length / 2);
    expect(parse(frame.slice(0, cut))).toEqual([]);
    expect(parse(`${frame.slice(cut)}: heartbeat\n\ndata: {not json\n\n`)).toEqual([{ type: 'indexRemoved', sessionId: 's1' }]);
    expect(parse(encodeLocalServeEvent({ type: 'indexRemoved', sessionId: 's2' }).replace(/\n/g, '\r\n'))).toEqual([{ type: 'indexRemoved', sessionId: 's2' }]);
  });
});
