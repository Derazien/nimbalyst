/**
 * Keyboard routing between the embedded terminal and window-level shortcut listeners.
 *
 * The genuine `claude` CLI (and plain shells) run inside a ghostty-web terminal. Window-level
 * CAPTURE keydown listeners (global shortcuts, navigation dialogs, extension keybindings) run
 * before ghostty sees a key, so a focused terminal loses Ctrl+L, Ctrl+K, Ctrl+B and friends.
 * Those listeners call `terminalOwnsKey(e)` and bail so the key flows to the terminal untouched.
 */

/** Marker attribute placed on the terminal container element. */
export const TERMINAL_KEY_SURFACE_ATTR = 'data-nim-terminal';

const TERMINAL_SELECTOR = `[${TERMINAL_KEY_SURFACE_ATTR}]`;

/** True when the key event originates from inside a terminal surface. */
export function isTerminalKeyTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest(TERMINAL_SELECTOR)) {
    return true;
  }
  // Fallback for events dispatched on window/document (target is not an Element).
  if (!(target instanceof Element) && typeof document !== 'undefined') {
    const active = document.activeElement;
    return !!active && active.closest(TERMINAL_SELECTOR) !== null;
  }
  return false;
}

/**
 * Keys that must still reach Nimbalyst when the terminal is focused:
 * terminal toggle (Ctrl+` / Ctrl+Shift+`), tab switch (Ctrl+1..9), Ctrl+Shift+W, Ctrl+Shift+K.
 * metaKey is treated like ctrlKey for macOS parity.
 */
export function shouldTerminalKeepKey(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (event.key === '`' || event.code === 'Backquote') return true;
  if (!event.shiftKey && /^[1-9]$/.test(event.key)) return true;
  if (event.shiftKey) {
    const key = event.key.toLowerCase();
    return key === 'w' || key === 'k';
  }
  return false;
}

/** True when the focused terminal should receive this key and window shortcuts must not. */
export function terminalOwnsKey(event: KeyboardEvent): boolean {
  return isTerminalKeyTarget(event) && !shouldTerminalKeepKey(event);
}
