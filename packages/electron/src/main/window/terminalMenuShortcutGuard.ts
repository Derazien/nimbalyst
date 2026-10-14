/**
 * Menu shortcuts yield to a focused terminal.
 *
 * Application-menu accelerators (File > Save is Ctrl+S) are handled by the
 * main process before the page sees the key, so `terminalOwnsKey` in the
 * renderer cannot keep them for the terminal. The Claude CLI needs Ctrl+S
 * (stash) and the chord Ctrl+X Ctrl+S (send queued messages now). The renderer
 * reports when a terminal has focus; while it does, every menu shortcut except
 * the few Nimbalyst keeps (see `shouldTerminalKeepKey`) goes to the terminal.
 */

import type { BrowserWindow, Input } from 'electron';
import { safeOn } from '../utils/ipcRegistry';

/** Same keys as the renderer's `shouldTerminalKeepKey`: terminal toggle, tab switch, Ctrl+Shift+W/K. */
export function terminalKeepsMenuKey(input: Pick<Input, 'control' | 'meta' | 'alt' | 'shift' | 'key' | 'code'>): boolean {
  if (!(input.control || input.meta) || input.alt) return false;
  if (input.key === '`' || input.code === 'Backquote') return true;
  if (!input.shift && /^[1-9]$/.test(input.key)) return true;
  if (input.shift) {
    const key = input.key.toLowerCase();
    return key === 'w' || key === 'k';
  }
  return false;
}

/** Whether menu shortcuts must be ignored for this key press. */
export function menuShortcutsYieldToTerminal(
  input: Pick<Input, 'control' | 'meta' | 'alt' | 'shift' | 'key' | 'code'>,
  terminalFocused: boolean,
): boolean {
  return terminalFocused && !terminalKeepsMenuKey(input);
}

const terminalFocusedByContents = new Map<number, boolean>();
let focusIpcRegistered = false;

/** Install on every app window: the renderer sends `terminal:focus-changed` when a terminal gains or loses focus. */
export function installTerminalMenuShortcutGuard(window: BrowserWindow): void {
  if (!focusIpcRegistered) {
    focusIpcRegistered = true;
    safeOn('terminal:focus-changed', (event, focused: boolean) => {
      terminalFocusedByContents.set(event.sender.id, focused === true);
    });
  }
  const contents = window.webContents;
  const id = contents.id;
  contents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    contents.setIgnoreMenuShortcuts(menuShortcutsYieldToTerminal(input, terminalFocusedByContents.get(id) === true));
  });
  contents.once('destroyed', () => terminalFocusedByContents.delete(id));
}
