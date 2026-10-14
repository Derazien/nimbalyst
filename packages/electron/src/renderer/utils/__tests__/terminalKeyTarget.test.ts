// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTerminalFocusReporter, TERMINAL_KEY_SURFACE_ATTR, terminalOwnsKey } from '../terminalKeyTarget';

function keyOn(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function mount(): { inside: HTMLElement; outside: HTMLElement } {
  document.body.innerHTML = `
    <div ${TERMINAL_KEY_SURFACE_ATTR}><textarea id="inside"></textarea></div>
    <textarea id="outside"></textarea>`;
  return {
    inside: document.getElementById('inside')!,
    outside: document.getElementById('outside')!,
  };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('terminalOwnsKey', () => {
  it('owns keys from inside the terminal surface, including app chords like Ctrl+L', () => {
    const { inside } = mount();
    expect(terminalOwnsKey(keyOn(inside, { key: 'a' }))).toBe(true);
    expect(terminalOwnsKey(keyOn(inside, { key: 'l', ctrlKey: true }))).toBe(true);
    expect(terminalOwnsKey(keyOn(inside, { key: 'l', metaKey: true }))).toBe(true);
  });

  it('keeps the terminal toggle and tab-switch chords for the app', () => {
    const { inside } = mount();
    expect(terminalOwnsKey(keyOn(inside, { key: '1', ctrlKey: true }))).toBe(false);
    expect(terminalOwnsKey(keyOn(inside, { key: '9', metaKey: true }))).toBe(false);
    expect(terminalOwnsKey(keyOn(inside, { key: '`', code: 'Backquote', ctrlKey: true }))).toBe(false);
    expect(terminalOwnsKey(keyOn(inside, { key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(terminalOwnsKey(keyOn(inside, { key: 'W', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(terminalOwnsKey(keyOn(inside, { key: 'K', ctrlKey: true, shiftKey: true }))).toBe(false);
    // Plain Ctrl+K and Ctrl+Alt+1 are not on the keep-list.
    expect(terminalOwnsKey(keyOn(inside, { key: 'k', ctrlKey: true }))).toBe(true);
    expect(terminalOwnsKey(keyOn(inside, { key: '1', ctrlKey: true, altKey: true }))).toBe(true);
  });

  it('does not own keys from outside the terminal', () => {
    const { outside } = mount();
    expect(terminalOwnsKey(keyOn(outside, { key: 'l', ctrlKey: true }))).toBe(false);
  });

  it('falls back to the focused element when the event targets the window', () => {
    const { inside } = mount();
    inside.focus();
    const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true });
    window.dispatchEvent(event);
    expect(terminalOwnsKey(event)).toBe(true);
  });
});

describe('initTerminalFocusReporter', () => {
  it('tells main when the terminal gains and loses focus, once per change', async () => {
    document.body.innerHTML = `<div ${TERMINAL_KEY_SURFACE_ATTR}><textarea id="t"></textarea></div><input id="o" />`;
    const send = vi.fn();
    const stop = initTerminalFocusReporter(send);
    (document.getElementById('t') as HTMLElement).focus();
    (document.getElementById('t') as HTMLElement).focus();
    (document.getElementById('o') as HTMLElement).focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    expect(send.mock.calls).toEqual([['terminal:focus-changed', true], ['terminal:focus-changed', false]]);
  });
});
