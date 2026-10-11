// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * Production leak, 2026-10-11: after ~30 h every terminal failed with
 * "Cannot allocate Wasm memory for new instance" because ~120 disposed
 * terminals' WASM instances were still reachable. ghostty-web registers
 * `document` listeners while opening a terminal (SelectionManager's anonymous
 * mousedown, Terminal's mouseup) that its own dispose() never removes, and a
 * document listener keeps the whole Terminal -> WasmTerminal -> instance chain
 * alive forever. TerminalPanel must not leave any behind when it unmounts.
 */

const { created, FakeTerminal } = vi.hoisted(() => {
  const created: Array<{ disposed: boolean; registered: unknown[] }> = [];

  class FakeTerminal {
    cols = 80;
    rows = 24;
    options = { theme: {} };
    renderer = { setTheme() {} };
    buffer = { active: { cursorX: 0, cursorY: 0, length: 0, getLine: () => undefined } };
    disposed = false;
    registered: unknown[] = [];
    constructor() {
      created.push(this);
    }
    loadAddon() {}
    open() {
      // Mirrors ghostty-web's open(): listeners on `document` that capture `this`.
      const onMouseDown = () => this;
      this.registered.push(onMouseDown, this.handleMouseUp);
      document.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mouseup', this.handleMouseUp);
    }
    handleMouseUp = () => void this.rows;
    dispose() {
      this.disposed = true; // like the real one: removes none of the above
    }
    write() {}
    scrollToBottom() {}
    focus() {}
    blur() {}
    onData() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
  }

  return { created, FakeTerminal };
});

vi.mock('ghostty-web', () => ({
  Terminal: FakeTerminal,
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    dispose() {}
  },
  OSC8LinkProvider: class {},
  UrlRegexProvider: class {},
}));

vi.mock('../ghosttyInstance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ghosttyInstance')>()),
  loadTerminalGhostty: vi.fn(async () => ({})),
}));

vi.mock('../terminalVisibility', () => ({
  isElementMeasurable: () => true,
  waitUntilElementMeasurable: async () => 'measurable',
  waitUntilTerminalPainted: async () => 'painted',
}));

vi.mock('@nimbalyst/runtime/store', async () => {
  const { atom } = await import('jotai');
  return { themeIdAtom: atom('dark') };
});

import { TerminalPanel } from '../TerminalPanel';

/** Document listeners currently registered, by identity. */
function trackDocumentListeners() {
  const live = new Set<unknown>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(((t: string, l: unknown, o?: unknown) => {
    live.add(l);
    add(t, l as EventListener, o as AddEventListenerOptions);
  }) as never);
  vi.spyOn(document, 'removeEventListener').mockImplementation(((t: string, l: unknown, o?: unknown) => {
    live.delete(l);
    remove(t, l as EventListener, o as EventListenerOptions);
  }) as never);
  return live;
}

beforeEach(() => {
  created.length = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    openExternal: vi.fn(),
    terminal: {
      initialize: vi.fn(async () => ({ success: true })),
      ensureClaudeCliSession: vi.fn(async () => ({ success: true })),
      onOutput: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
      getRestoreSnapshot: vi.fn(async () => ({ sequence: 0 })),
      updateRenderState: vi.fn(async () => {}),
      resize: vi.fn(),
      write: vi.fn(),
      clearScrollback: vi.fn(),
    },
  };
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = () =>
  render(<TerminalPanel terminalId="t1" workspacePath="/ws" isActive panelVisible />);

describe('TerminalPanel disposal', () => {
  it('leaves no document listener behind once a terminal is unmounted', async () => {
    const live = trackDocumentListeners();
    const { unmount } = mount();
    await waitFor(() => expect(created.length).toBe(1));
    await waitFor(() => expect(created[0].registered.every((l) => live.has(l))).toBe(true));

    unmount();

    expect(created[0].disposed).toBe(true);
    expect(created[0].registered.filter((l) => live.has(l))).toHaveLength(0);
  });

  it('leaves no document listener behind when init is torn down and re-run (Retry / wasm rebuild)', async () => {
    const live = trackDocumentListeners();
    const first = mount();
    await waitFor(() => expect(created.length).toBe(1));
    first.unmount();
    const second = mount();
    await waitFor(() => expect(created.length).toBe(2));
    second.unmount();

    expect(created.every((t) => t.disposed)).toBe(true);
    expect(created.flatMap((t) => t.registered).filter((l) => live.has(l))).toHaveLength(0);
  });
});
