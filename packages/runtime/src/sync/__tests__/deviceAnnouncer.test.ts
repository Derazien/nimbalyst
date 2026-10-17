// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceAnnouncer, DEVICE_ANNOUNCE_INTERVAL_MS } from '../deviceAnnouncer';
import type { DeviceInfo } from '../types';

const device: DeviceInfo = {
  deviceId: 'abc123',
  name: 'Desk',
  type: 'desktop',
  platform: 'windows',
  appVersion: '1.0.0',
  connectedAt: 1,
  lastActiveAt: 2,
  isFocused: true,
  status: 'active',
};

function emfile(): NodeJS.ErrnoException {
  return Object.assign(new Error("EMFILE: too many open files, open 'computer-identity'"), { code: 'EMFILE' });
}

describe('createDeviceAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives a failed identity read inside the timer and announces on the next tick', () => {
    const send = vi.fn();
    const warn = vi.fn();
    const deviceInfo = vi.fn<() => DeviceInfo | undefined>()
      .mockImplementationOnce(() => { throw emfile(); })
      .mockReturnValue(device);
    const announcer = createDeviceAnnouncer({ deviceInfo, canSend: () => true, send, warn });

    announcer.start();
    // An uncaught throw from a timer callback is rethrown by advanceTimersByTime.
    expect(() => vi.advanceTimersByTime(DEVICE_ANNOUNCE_INTERVAL_MS)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('EMFILE');

    vi.advanceTimersByTime(DEVICE_ANNOUNCE_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'deviceAnnounce',
      device: expect.objectContaining({ deviceId: 'abc123', lastActiveAt: 2 }),
    });
    expect(warn).toHaveBeenCalledTimes(1);

    announcer.stop();
  });

  it('does not read the identity while the index socket is closed', () => {
    const deviceInfo = vi.fn(() => device);
    const announcer = createDeviceAnnouncer({ deviceInfo, canSend: () => false, send: vi.fn(), warn: vi.fn() });

    announcer.announce();

    expect(deviceInfo).not.toHaveBeenCalled();
  });

  it('fills lastActiveAt when the host did not provide one', () => {
    vi.setSystemTime(5000);
    const send = vi.fn();
    const announcer = createDeviceAnnouncer({
      deviceInfo: () => ({ ...device, lastActiveAt: undefined as unknown as number }),
      canSend: () => true,
      send,
      warn: vi.fn(),
    });

    announcer.announce();

    expect(send).toHaveBeenCalledWith({ type: 'deviceAnnounce', device: expect.objectContaining({ lastActiveAt: 5000 }) });
  });

  it('skips the announce when the device info is not available', () => {
    const send = vi.fn();
    const announcer = createDeviceAnnouncer({ deviceInfo: () => undefined, canSend: () => true, send, warn: vi.fn() });

    announcer.announce();

    expect(send).not.toHaveBeenCalled();
  });

  it('survives a failed send inside the timer', () => {
    const warn = vi.fn();
    const send = vi.fn(() => { throw new Error('socket closed'); });
    const announcer = createDeviceAnnouncer({ deviceInfo: () => device, canSend: () => true, send, warn });

    announcer.start();

    expect(() => vi.advanceTimersByTime(DEVICE_ANNOUNCE_INTERVAL_MS)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);

    announcer.stop();
  });

  it('restarts cleanly and stops ticking after stop', () => {
    const send = vi.fn();
    const announcer = createDeviceAnnouncer({ deviceInfo: () => device, canSend: () => true, send, warn: vi.fn() });

    announcer.start();
    announcer.start();
    vi.advanceTimersByTime(DEVICE_ANNOUNCE_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);

    announcer.stop();
    vi.advanceTimersByTime(DEVICE_ANNOUNCE_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
