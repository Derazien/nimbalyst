// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let userData: string;
vi.mock('electron', () => ({
  app: { getPath: () => userData, isReady: () => true, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const WORKSPACE = path.join(os.tmpdir(), 'terminal-persist-workspace');
const TERMINAL_ID = 'live';

let terminals: typeof import('../../utils/terminalStore');
let settings: typeof import('../../utils/settingsFiles');
let persist: (terminal: Record<string, unknown>, options?: { force?: boolean }) => Promise<void>;
let storeWrites: { mock: { calls: unknown[] } };

/** What a restart would read back; quitting flushes background saves first. */
const cursorOnDisk = () => {
  settings.flushSettingsSync();
  const file = JSON.parse(fs.readFileSync(path.join(userData, 'terminal-store.json'), 'utf8'));
  const [workspace] = Object.values(file.workspaces) as Array<{ terminals: Record<string, any> }>;
  return workspace.terminals[TERMINAL_ID].cursorY;
};

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-persist-'));
  vi.resetModules();
  terminals = await import('../../utils/terminalStore');
  settings = await import('../../utils/settingsFiles');
  const { TerminalSessionManager } = await import('../TerminalSessionManager');
  const { default: Store } = await import('../../utils/privateSettingsStore');
  const manager = new TerminalSessionManager();
  // The private method every persist tick goes through; no PTY is needed to reach it.
  persist = (terminal, options) => (manager as any).persistTerminalState(TERMINAL_ID, terminal, options);

  terminals.createTerminalInstance(WORKSPACE, {
    id: TERMINAL_ID,
    title: 'live',
    shellName: 'pwsh',
    shellPath: 'pwsh.exe',
    cwd: WORKSPACE,
    createdAt: 1,
    lastActiveAt: 1,
  });
  storeWrites = vi.spyOn(Store.prototype, 'store', 'set');
});

afterEach(async () => {
  terminals.flushTerminalStore();
  vi.restoreAllMocks();
  await settings.settingsWritesSettled();
  fs.rmSync(userData, { recursive: true, force: true });
});

it('does not block on a store write for each tick of live output, but does when forced', async () => {
  const terminal: Record<string, unknown> = {
    sessionId: TERMINAL_ID,
    workspacePath: WORKSPACE,
    shell: { name: 'pwsh', path: 'pwsh.exe' },
    cwd: WORKSPACE,
    historyFile: '',
    cols: 80,
    rows: 24,
    cursorX: 0,
    cursorY: 0,
    screenLines: [],
    scrollbackBuffer: '',
    metadata: {},
    outputSequence: 0,
  };

  // Output keeps arriving: the cursor moves and the scrollback grows every tick.
  for (let tick = 1; tick <= 5; tick++) {
    terminal.cursorY = tick;
    terminal.scrollbackBuffer = `line ${tick}\n`.repeat(tick);
    await persist(terminal);
  }
  expect(storeWrites.mock.calls).toHaveLength(0);

  // Exit, destroy and quit all persist with force, and must not wait for a timer.
  terminal.cursorY = 6;
  await persist(terminal, { force: true });
  expect(storeWrites.mock.calls).toHaveLength(1);
  expect(cursorOnDisk()).toBe(6);
});

it('asks a Kimi Code CLI terminal for its turn state instead of a Claude PID file, so Stop reaches kimi', async () => {
  const { TerminalSessionManager } = await import('../TerminalSessionManager');
  const manager = new TerminalSessionManager();
  const writes: string[] = [];
  let state: 'running' | 'idle' = 'running';
  // No Claude PID file exists for this pid; only the reader knows the state.
  (manager as any).terminals.set('kimi', {
    pty: { pid: 999_999_999, write: (d: string) => { writes.push(d); state = 'idle'; }, kill: () => {} },
    readCliTurnState: () => state,
  });

  expect(await manager.getClaudeCliLiveTurnState('kimi')).toBe('running');
  const result = await manager.interruptClaudeCliTurn('kimi');
  expect(writes).toEqual(['\x03']);
  expect(result).toEqual({ success: true, resolvedAfter: 'first-interrupt' });
});

it('does not let an old process exiting late remove the terminal that replaced it under the same id', async () => {
  const { TerminalSessionManager } = await import('../TerminalSessionManager');
  const manager = new TerminalSessionManager();
  let exitOld: ((e: { exitCode: number }) => Promise<void>) | undefined;
  const oldProcess = {
    pty: { pid: 1, onData: () => {}, onExit: (cb: typeof exitOld) => { exitOld = cb; }, kill: () => {} },
    sessionId: TERMINAL_ID, workspacePath: WORKSPACE, shell: { name: 'kimi', path: 'kimi.exe' }, cwd: WORKSPACE,
    historyFile: '', cols: 80, rows: 24, cursorX: 0, cursorY: 0, scrollbackBuffer: '', metadata: {}, outputSequence: 0,
  };
  await (manager as any).registerTerminalProcess(TERMINAL_ID, oldProcess);
  // destroyTerminal drops the entry at once; a relaunch registers a new one before the old exit arrives.
  (manager as any).terminals.delete(TERMINAL_ID);
  const replacement = { ...oldProcess, pty: { ...oldProcess.pty, pid: 2 } };
  (manager as any).terminals.set(TERMINAL_ID, replacement);

  await exitOld!({ exitCode: 0 });
  expect((manager as any).terminals.get(TERMINAL_ID)).toBe(replacement);
});

it('reads a claude-code-cli screen from its own copy of the PTY output, with no renderer push, and refreshes the mode chip', async () => {
  const nodePty = createRequire(import.meta.url)('node-pty');
  const dataListeners: Array<(data: string) => void> = [];
  const feed = (data: string) => dataListeners.forEach((cb) => cb(data));
  let exit!: (e: { exitCode: number }) => Promise<void>;
  const resizes: Array<[number, number]> = [];
  vi.spyOn(nodePty, 'spawn').mockImplementation((() => ({
    pid: 1, kill: () => {}, write: () => {}, resize: (c: number, r: number) => resizes.push([c, r]),
    onData: (cb: (data: string) => void) => { dataListeners.push(cb); },
    onExit: (cb: typeof exit) => { exit = cb; },
  })) as any);
  const { TerminalSessionManager } = await import('../TerminalSessionManager');
  const manager = new TerminalSessionManager();
  const pushed: string[][] = [];
  await manager.createClaudeCliTerminal(TERMINAL_ID, {
    cwd: WORKSPACE, workspacePath: WORKSPACE, cols: 60, rows: 6,
    spawnConfig: { executable: 'claude', args: [], env: {} } as any,
    onScreenLines: (lines) => pushed.push(lines),
  });

  expect(manager.getScreenLines(TERMINAL_ID)).toHaveLength(6);
  vi.useFakeTimers();
  try {
    feed('\x1b[2J\x1b[1;1H Would you like to proceed?\r\n \x1b[36m❯ 1. Yes\x1b[0m');
    feed('\r\n   2. No');
    expect(pushed).toHaveLength(0);
    vi.advanceTimersByTime(200);
  } finally {
    vi.useRealTimers();
  }
  // One trailing notification for the burst, carrying the whole screen.
  expect(pushed).toHaveLength(1);
  expect(manager.getScreenLines(TERMINAL_ID)!.map((l) => l.trimEnd())).toEqual([
    ' Would you like to proceed?', ' ❯ 1. Yes', '   2. No', '', '', '',
  ]);

  // A resize reaches the copy, and a renderer push does not replace it while the copy is live.
  manager.resizeTerminal(TERMINAL_ID, 60, 8);
  expect(manager.getScreenLines(TERMINAL_ID)).toHaveLength(8);
  manager.updateTerminalRenderState(TERMINAL_ID, { screenLines: ['stale'] });
  expect(manager.getScreenLines(TERMINAL_ID)![0]).toContain('Would you like');

  // Exit disposes the copy; the timer is cleared with it, so nothing fires afterwards.
  const shadow = (manager as any).terminals.get(TERMINAL_ID).shadowScreen;
  expect(shadow.live).toBe(true);
  await exit({ exitCode: 0 });
  expect(shadow.live).toBe(false);
});
