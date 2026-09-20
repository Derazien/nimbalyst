// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { setTerminalPainting } from '../terminalRenderGate';

/** The shape the gate needs: ghostty's renderer, whose `render` the loop calls each frame. */
const fakeTerminal = () => {
  const render = vi.fn();
  return { renderer: { render }, render };
};

describe('terminalRenderGate', () => {
  it('stops a hidden terminal painting and paints again when it is shown', () => {
    const terminal = fakeTerminal();

    setTerminalPainting(terminal, false);
    terminal.renderer.render();
    expect(terminal.render).not.toHaveBeenCalled();

    // Repeating either state must not lose the original renderer.
    setTerminalPainting(terminal, false);
    setTerminalPainting(terminal, true);
    setTerminalPainting(terminal, true);
    terminal.renderer.render();
    expect(terminal.render).toHaveBeenCalledTimes(1);
  });

  it('leaves a terminal alone when it has no renderer to pause', () => {
    expect(() => setTerminalPainting(undefined, false)).not.toThrow();
    expect(() => setTerminalPainting({} as never, false)).not.toThrow();
    expect(() => setTerminalPainting({ renderer: {} } as never, true)).not.toThrow();
  });
});
