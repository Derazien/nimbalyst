// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData: string;
vi.mock('electron', () => ({ app: { getPath: () => userData, isReady: () => true } }));

type TerminalStoreModule = typeof import('../terminalStore');
let terminals: TerminalStoreModule;
let settings: typeof import('../settingsFiles');
let storeWrites: { mock: { calls: unknown[] } };

const WORKSPACE = path.join(os.tmpdir(), 'terminal-store-workspace');

const instance = (id: string) => ({
  id,
  title: id,
  shellName: 'pwsh',
  shellPath: 'pwsh.exe',
  cwd: WORKSPACE,
  createdAt: 1,
  lastActiveAt: 1,
});

/** What a restart would actually read back; quitting flushes background saves first. */
const onDisk = (id: string) => {
  settings.flushSettingsSync();
  const file = JSON.parse(fs.readFileSync(path.join(userData, 'terminal-store.json'), 'utf8'));
  const [workspace] = Object.values(file.workspaces) as Array<{ terminals: Record<string, any> }>;
  return workspace.terminals[id];
};

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-store-'));
  vi.useFakeTimers();
  // terminalStore memoizes its store, so each test needs a fresh module.
  vi.resetModules();
  terminals = await import('../terminalStore');
  settings = await import('../settingsFiles');
  const { default: Store } = await import('../privateSettingsStore');
  // conf funnels every set() through the `store` setter, so this counts real
  // full-file writes (each one a temp write + fsync + rename) without
  // replacing them.
  storeWrites = vi.spyOn(Store.prototype, 'store', 'set');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await settings.settingsWritesSettled();
  fs.rmSync(userData, { recursive: true, force: true });
});

it('coalesces streaming snapshot updates into one disk write per window while reads stay fresh', () => {
  for (const id of ['a', 'b', 'c']) terminals.createTerminalInstance(WORKSPACE, instance(id));
  storeWrites.mock.calls.length = 0;

  // Ten persist ticks for each of three terminals with live output.
  for (let tick = 1; tick <= 10; tick++) {
    for (const id of ['a', 'b', 'c']) {
      terminals.updateTerminalInstance(
        WORKSPACE,
        id,
        { cursorY: tick, screenLines: [`${id}:${tick}`], lastActiveAt: tick },
        { defer: true },
      );
    }
  }

  // Nothing has blocked on the disk yet, and a caller still sees the latest state.
  expect(storeWrites.mock.calls).toHaveLength(0);
  expect(onDisk('a').cursorY).toBeUndefined();
  expect(terminals.getTerminalInstance(WORKSPACE, 'b')?.cursorY).toBe(10);

  vi.advanceTimersByTime(terminals.TERMINAL_STORE_FLUSH_MS);

  // Thirty updates cost one write, and all of them landed.
  expect(storeWrites.mock.calls).toHaveLength(1);
  for (const id of ['a', 'b', 'c']) {
    expect(onDisk(id)).toMatchObject({ cursorY: 10, screenLines: [`${id}:10`], lastActiveAt: 10 });
  }
});

it('lets an immediate write supersede older deferred state instead of being overwritten by it', () => {
  for (const id of ['a', 'b']) terminals.createTerminalInstance(WORKSPACE, instance(id));
  terminals.updateTerminalInstance(WORKSPACE, 'a', { cols: 80, cursorY: 4 }, { defer: true });
  terminals.updateTerminalInstance(WORKSPACE, 'b', { cursorY: 9 }, { defer: true });

  // A resize persisted on the forced path, and a terminal closed by the user.
  terminals.updateTerminalInstance(WORKSPACE, 'a', { cols: 120 });
  terminals.deleteTerminalInstance(WORKSPACE, 'b');

  // The immediate write carried the deferred cursor with it, so nothing was lost...
  expect(onDisk('a')).toMatchObject({ cols: 120, cursorY: 4 });
  expect(terminals.getTerminalInstance(WORKSPACE, 'a')?.cols).toBe(120);

  // ...and the stale deferred values cannot come back when the window elapses.
  vi.advanceTimersByTime(terminals.TERMINAL_STORE_FLUSH_MS);
  expect(onDisk('a').cols).toBe(120);
  expect(terminals.getTerminalInstance(WORKSPACE, 'a')?.cols).toBe(120);
  expect(onDisk('b')).toBeUndefined();
  expect(terminals.getTerminalInstance(WORKSPACE, 'b')).toBeUndefined();
});
