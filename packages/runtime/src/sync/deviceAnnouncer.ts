import type { DeviceInfo } from './types';

/** Re-announce every 30 seconds to handle server hibernation and presence updates. */
export const DEVICE_ANNOUNCE_INTERVAL_MS = 30_000;

export interface DeviceAnnounceMessage {
  type: 'deviceAnnounce';
  device: DeviceInfo;
}

export interface DeviceAnnouncerDeps {
  /** Who this client is. May read disk and throw; a throw skips that one announce. */
  deviceInfo: () => DeviceInfo | undefined;
  /** Whether the index socket is open right now. Checked before reading the identity. */
  canSend: () => boolean;
  send: (message: DeviceAnnounceMessage) => void;
  warn?: (message: string) => void;
}

export interface DeviceAnnouncer {
  announce(): void;
  start(): void;
  stop(): void;
}

/**
 * The periodic device announce to the index server.
 *
 * Nothing here may throw out of the interval: an uncaught exception in a timer
 * callback surfaces as a modal in the desktop app. A failed identity read (for
 * example EMFILE while the process is out of file handles) skips that one
 * announce and the next tick tries again. It never substitutes another identity.
 */
export function createDeviceAnnouncer(deps: DeviceAnnouncerDeps): DeviceAnnouncer {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let timer: ReturnType<typeof setInterval> | null = null;

  const announce = (): void => {
    try {
      // Also guards against "Sent before connected" errors on a half-open socket.
      if (!deps.canSend()) return;
      const device = deps.deviceInfo();
      if (!device) return;
      deps.send({
        type: 'deviceAnnounce',
        device: {
          ...device,
          // Ensure lastActiveAt is current (callback may provide its own)
          lastActiveAt: device.lastActiveAt ?? Date.now(),
        },
      });
    } catch (error) {
      warn(`[CollabV3] Device announce skipped, retrying in ${DEVICE_ANNOUNCE_INTERVAL_MS / 1000}s: ${(error as Error)?.message || error}`);
    }
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    announce,
    start() {
      stop();
      timer = setInterval(announce, DEVICE_ANNOUNCE_INTERVAL_MS);
    },
    stop,
  };
}
