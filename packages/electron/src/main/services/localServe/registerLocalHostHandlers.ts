/**
 * IPC for Settings > Local hosts (#416), and the startup connect.
 *
 * Save tests the address and token against the node before storing anything,
 * so a typo never leaves a saved host that silently shows nothing.
 */

import { app } from 'electron';

import { safeHandle } from '../../utils/ipcRegistry';
import { logger } from '../../utils/logger';
import { remoteSessions } from '../ai/remoteSessions';
import { getSyncProvider } from '../SyncManager';
import { createLocalHostConnection } from './localHostConnection';
import { validateLocalHostInput } from './localHostSettings';
import { localHostStore } from './localHostStore';

export const localHostConnection = createLocalHostConnection({
  store: localHostStore,
  target: remoteSessions,
  // The cloud device id when personal sync is up; any id but the node's works.
  localDeviceId: () => getSyncProvider()?.getLocalDeviceInfo?.()?.deviceId ?? 'desktop-local',
});

export function registerLocalHostHandlers(): void {
  safeHandle('local-host:status', () => localHostConnection.status());

  safeHandle('local-host:test', async (_event, url: unknown, token: unknown) => {
    const input = validateLocalHostInput(url, token);
    if (!input.ok) return { ok: false, error: input.error };
    return localHostConnection.test(input.url, (token as string).trim());
  });

  safeHandle('local-host:save', async (_event, url: unknown, token: unknown) => {
    const input = validateLocalHostInput(url, token);
    if (!input.ok) throw new Error(input.error);
    const reached = await localHostConnection.test(input.url, (token as string).trim());
    if (!reached.ok) throw new Error(reached.error ?? 'The node could not be reached.');
    localHostStore.save(input.url, (token as string).trim());
    await localHostConnection.connect();
    return localHostConnection.status();
  });

  safeHandle('local-host:remove', async () => {
    localHostStore.remove();
    await localHostConnection.connect();
    return localHostConnection.status();
  });

  void app.whenReady()
    .then(() => localHostConnection.connect())
    .catch((error: unknown) => {
      logger.main.warn('[LocalHost] could not connect the saved host', { error: error instanceof Error ? error.message : String(error) });
    });
}
