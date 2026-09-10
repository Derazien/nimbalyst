// @vitest-environment node
/**
 * A backend module's one-argument log line arrives with `data: undefined`, and
 * forwarding that argument made electron-log print a literal " undefined" after
 * every such line in main.log.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.log.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: {
    on: vi.fn(), once: vi.fn(), whenReady: vi.fn(() => Promise.resolve()),
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath, getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'), isPackaged: false,
  },
  BrowserWindow: class { static getAllWindows = vi.fn(() => []); },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import { logger } from '../../utils/logger';

const CTX = { extensionId: 'com.example.ext', moduleId: 'engine', workspacePath: '/ws', grantedPermissions: [] };

function deliver(msg: Record<string, unknown>) {
  const managed = {
    args: { extensionId: CTX.extensionId, module: { id: CTX.moduleId }, workspacePath: CTX.workspacePath },
    state: { status: 'running', startedAt: 0, methods: [] },
    pending: new Map(),
  };
  (new PrivilegedExtensionHost() as unknown as {
    handleBackendMessage: (m: unknown, msg: unknown, c: unknown) => void;
  }).handleBackendMessage(managed, msg, CTX);
}

describe('PrivilegedExtensionHost backend log forwarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a line without data as the line alone', () => {
    const info = vi.spyOn(logger.main, 'info').mockImplementation(() => undefined);
    deliver({ kind: 'log', level: 'info', message: 'ready', data: undefined });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual(['[ext:com.example.ext/engine] ready']);
  });

  it('still forwards data the module did send', () => {
    const warn = vi.spyOn(logger.main, 'warn').mockImplementation(() => undefined);
    deliver({ kind: 'log', level: 'warn', message: 'slow', data: { ms: 12 } });
    expect(warn.mock.calls[0]).toEqual(['[ext:com.example.ext/engine] slow', { ms: 12 }]);
  });
});
