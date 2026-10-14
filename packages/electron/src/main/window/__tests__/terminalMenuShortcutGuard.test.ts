// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/ipcRegistry', () => ({ safeOn: vi.fn() }));

import { menuShortcutsYieldToTerminal } from '../terminalMenuShortcutGuard';

const key = (k: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  control: false, shift: false, alt: false, meta: false, key: k, code: k === '`' ? 'Backquote' : `Key${k.toUpperCase()}`, ...mods,
});

describe('menuShortcutsYieldToTerminal', () => {
  it('lets a focused terminal have Ctrl+S (the Claude CLI send-now chord is Ctrl+X Ctrl+S)', () => {
    expect(menuShortcutsYieldToTerminal(key('s', { control: true }), true)).toBe(true);
    expect(menuShortcutsYieldToTerminal(key('s', { control: true }), false)).toBe(false);
  });

  it('keeps the terminal toggle, tab switch and Ctrl+Shift+W/K for Nimbalyst', () => {
    expect(menuShortcutsYieldToTerminal(key('`', { control: true }), true)).toBe(false);
    expect(menuShortcutsYieldToTerminal(key('3', { control: true }), true)).toBe(false);
    expect(menuShortcutsYieldToTerminal(key('W', { control: true, shift: true }), true)).toBe(false);
  });
});
