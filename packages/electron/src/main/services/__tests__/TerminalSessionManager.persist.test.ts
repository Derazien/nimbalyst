// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData: string;
vi.mock('electron', () => ({
  app: { getPath: () => userData, isReady: () => true, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const WORKSPACE = path.join(os.tmpdir(), 'terminal-persist-workspace');
const TERMINAL_ID = 'live';

let terminals: typeof import('../../utils/terminalStore');
let persist: (terminal: Record<string, unknown>, options?: { force?: boolean }) => Promise<void>;
let storeWrites: { mock: { calls: unknown[] } };

const cursorOnDisk = () => {
  const file = JSON.parse(fs.readFileSync(path.join(userData, 'terminal-store.json'), 'utf8'));
  const [workspace] = Object.values(file.workspaces) as Array<{ terminals: Record<string, any> }>;
  return workspace.terminals[TERMINAL_ID].cursorY;
};

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-persist-'));
  vi.resetModules();
  terminals = await import('../../utils/terminalStore');
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

afterEach(() => {
  terminals.flushTerminalStore();
  vi.restoreAllMocks();
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
