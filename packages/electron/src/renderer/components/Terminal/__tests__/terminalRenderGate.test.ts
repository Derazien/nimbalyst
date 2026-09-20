// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  SCROLLED_PAINT_INTERVAL_MS,
  setTerminalPainting,
  setTerminalRenderClock,
} from '../terminalRenderGate';

/** The shape the gate needs: ghostty's renderer, whose `render` the loop calls each frame. */
const fakeTerminal = () => {
  const painted = vi.fn();
  const terminal = { renderer: { render: painted } };
  /** One animation frame, as the library calls it. */
  const frame = (viewportY = 0) =>
    terminal.renderer.render(null, false, viewportY, null, 1);
  return { terminal, painted, frame };
};

let time = 0;
setTerminalRenderClock(() => time);
afterEach(() => {
  time = 0;
});

describe('terminalRenderGate', () => {
  it('stops a hidden terminal painting and paints again when it is shown', () => {
    const { terminal, painted, frame } = fakeTerminal();

    setTerminalPainting(terminal, false);
    frame();
    expect(painted).not.toHaveBeenCalled();

    // Repeating either state must not lose the real renderer.
    setTerminalPainting(terminal, false);
    setTerminalPainting(terminal, true);
    setTerminalPainting(terminal, true);
    frame();
    expect(painted).toHaveBeenCalledTimes(1);
  });

  it('paints every frame at the bottom, but throttles a terminal parked in the scrollback', () => {
    const { terminal, painted, frame } = fakeTerminal();
    setTerminalPainting(terminal, true);

    // At the bottom the library's own dirty rows are correct, so nothing is dropped.
    frame(0);
    frame(0);
    frame(0);
    expect(painted).toHaveBeenCalledTimes(3);

    // Scrolled back, the library redraws every row every frame: cap the rate.
    painted.mockClear();
    frame(40);
    frame(40);
    frame(40);
    expect(painted).toHaveBeenCalledTimes(1);

    time += SCROLLED_PAINT_INTERVAL_MS;
    frame(40);
    expect(painted).toHaveBeenCalledTimes(2);

    // Scrolling itself always paints, however fast the frames arrive.
    frame(41);
    frame(42);
    expect(painted).toHaveBeenCalledTimes(4);

    // And a caller that asks for a forced redraw is never dropped.
    terminal.renderer.render(null, true, 42, null, 1);
    expect(painted).toHaveBeenCalledTimes(5);
  });

  it('leaves a terminal alone when it has no renderer to gate', () => {
    expect(() => setTerminalPainting(undefined, false)).not.toThrow();
    expect(() => setTerminalPainting({} as never, false)).not.toThrow();
    expect(() => setTerminalPainting({ renderer: {} } as never, true)).not.toThrow();
  });
});
