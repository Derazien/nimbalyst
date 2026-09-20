import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  execSyncMock,
  execMock,
  spawnMock,
  execFileMock,
  safeHandleMock,
  findExecutableInWindowsPathMock,
  getEnhancedWindowsPathMock,
  simpleGitMock,
} = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execMock: vi.fn((_command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(new Error('offline'), '', '');
  }),
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  safeHandleMock: vi.fn(),
  findExecutableInWindowsPathMock: vi.fn(),
  getEnhancedWindowsPathMock: vi.fn(),
  simpleGitMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  exec: execMock,
  execSync: execSyncMock,
  execFile: execFileMock,
}));

vi.mock('../WindowsPathResolver', () => ({
  findExecutableInWindowsPath: findExecutableInWindowsPathMock,
  getEnhancedWindowsPath: getEnhancedWindowsPathMock,
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: safeHandleMock,
}));

vi.mock('../../utils/store', () => ({
  getAppSetting: vi.fn(() => null),
}));

vi.mock('../services/analytics/AnalyticsService.ts', () => ({
  AnalyticsService: {
    getInstance: () => ({
      sendEvent: vi.fn(),
    }),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: simpleGitMock,
}));

import { CLIManager } from '../CLIManager';

describe('CLIManager.checkClaudeCodeWindowsInstallation', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });

    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    getEnhancedWindowsPathMock.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs');
    findExecutableInWindowsPathMock.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
    simpleGitMock.mockReturnValue({
      version: vi.fn().mockResolvedValue({ installed: false }),
    });
    execSyncMock.mockReset();
    execFileMock.mockReset();
    execMock.mockClear();
    spawnMock.mockReset();
    safeHandleMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  /** Answer a candidate's version query without blocking the caller. */
  const answerExecFile = (versionOf: (command: string) => string | undefined) => {
    execFileMock.mockImplementation((command: string, _args: unknown, options: any, callback?: any) => {
      const done = typeof options === 'function' ? options : callback;
      const answer = versionOf(command);
      if (answer === undefined) done(new Error(`not found: ${command}`), '', '');
      else done(null, answer, '');
      return { kill: vi.fn() };
    });
  };

  it('detects a Windows npm installation exposed as claude.cmd on PATH, without blocking', async () => {
    answerExecFile((command) =>
      command === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd' ? '1.2.3\n' : undefined,
    );

    const manager = new CLIManager();
    const result = await manager.checkClaudeCodeWindowsInstallation();

    // A synchronous child process here froze the whole app for 5 s per project switch.
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.some(([command]) => command === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true);

    expect(findExecutableInWindowsPathMock).toHaveBeenCalledWith(
      ['claude.cmd', 'claude.exe'],
      'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs'
    );
    expect(result).toEqual({
      isPlatformWindows: true,
      gitVersion: undefined,
      claudeCodeVersion: '1.2.3',
    });
  });

  it('answers a repeat check from the last result instead of probing again', async () => {
    answerExecFile((command) =>
      command === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd' ? '1.2.3\n' : undefined,
    );
    const manager = new CLIManager();

    const [first, second] = await Promise.all([
      manager.checkClaudeCodeWindowsInstallation(),
      manager.checkClaudeCodeWindowsInstallation(),
    ]);
    const probesSoFar = execFileMock.mock.calls.length;
    const third = await manager.checkClaudeCodeWindowsInstallation();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // The renderer asks again on every workspace change; only the first may probe.
    expect(execFileMock.mock.calls.length).toBe(probesSoFar);
  });

  it('detects a Windows Codex installation exposed as codex.cmd on PATH', async () => {
    findExecutableInWindowsPathMock.mockImplementation((executables: string | string[]) => {
      if (Array.isArray(executables) && executables.includes('codex.cmd')) {
        return 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd';
      }
      return 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd';
    });

    spawnMock.mockImplementation((command: string, args: string[], options?: { shell?: boolean; env?: Record<string, string> }) => {
      expect(command).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd');
      expect(args).toEqual(['--version']);
      expect(options?.shell).toBe(false);
      expect(options?.env?.PATH).toBe('C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs');

      let stdoutHandler: ((data: Buffer | string) => void) | undefined;
      let closeHandler: ((code: number) => void) | undefined;
      const child = {
        stdout: {
          on: vi.fn((event: string, handler: (data: Buffer | string) => void) => {
            if (event === 'data') stdoutHandler = handler;
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          if (event === 'close') closeHandler = handler as (code: number) => void;
        }),
        kill: vi.fn(),
      };

      queueMicrotask(() => {
        stdoutHandler?.('codex 0.12.3\n');
        closeHandler?.(0);
      });

      return child as any;
    });

    const manager = new CLIManager();
    const result = await manager.checkInstallation('openai-codex');

    expect(result).toEqual({
      installed: true,
      version: '0.12.3',
      updateAvailable: false,
      path: 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd',
      latestVersion: undefined,
    });
    expect(findExecutableInWindowsPathMock).toHaveBeenCalledWith(
      ['codex.cmd', 'codex.exe'],
      'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs'
    );
  });
});
