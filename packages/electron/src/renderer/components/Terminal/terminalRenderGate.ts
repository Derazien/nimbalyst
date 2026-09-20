/**
 * Keep a terminal from repainting when nothing can come of it.
 *
 * `ghostty-web` runs its render loop on every animation frame for as long as
 * the terminal is open, and its renderer has two paths that make that painting
 * expensive for nothing:
 *
 *  1. It never checks whether the terminal is on screen. The Claude CLI
 *     raw-terminal drawer stays mounted while collapsed so the PTY survives, so
 *     a collapsed drawer repainted a zero-size canvas about 60 times a second.
 *     Measured live: 27 s of work in a 46 s recording, 11 s of it in `fillText`,
 *     with no terminal output at all.
 *  2. While the viewport is scrolled back (`viewportY > 0`) it marks EVERY row
 *     dirty on EVERY frame, discarding its own row-level dirty tracking:
 *     `(viewportY > 0 ? true : force || isRowDirty(row) || …)`. So a terminal
 *     the user has scrolled up in does a full repaint per frame even when it is
 *     visible and idle.
 *
 * The library exposes no pause or throttle (only `open` and `dispose`, and
 * disposing would tear down the live TUI), so this wraps the renderer's
 * `render` once per terminal: it drops the call while the terminal has no
 * visible box, and while scrolled back it lets at most one frame through per
 * `SCROLLED_PAINT_INTERVAL_MS`. Scrolling itself always paints, because the
 * viewport position changes. A terminal sitting at the bottom is untouched:
 * there the library's own dirty rows are correct and cheap.
 *
 * Feature-detected: if a future ghostty changes this shape, the gate turns into
 * a no-op and we are back to today's behavior rather than a crash.
 */

interface PaintableTerminal {
  renderer?: { render?: unknown };
}

/** Roughly 8 frames a second while parked in the scrollback. */
export const SCROLLED_PAINT_INTERVAL_MS = 125;

interface GateState {
  painting: boolean;
  lastViewportY: number;
  lastScrolledPaint: number;
  now: () => number;
}

const gates = new WeakMap<object, GateState>();

/** Injectable clock, for tests. */
let clock: () => number = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function setTerminalRenderClock(next: () => number): void {
  clock = next;
}

function attach(terminal: PaintableTerminal): GateState | undefined {
  const renderer = terminal.renderer;
  if (!renderer || typeof renderer.render !== 'function') return undefined;
  const existing = gates.get(terminal as object);
  if (existing) return existing;

  const state: GateState = {
    painting: true,
    lastViewportY: 0,
    lastScrolledPaint: -Infinity,
    now: () => clock(),
  };
  const real = renderer.render as (...args: unknown[]) => unknown;
  renderer.render = function gatedRender(this: unknown, ...args: unknown[]) {
    if (!state.painting) return undefined;
    // The loop calls render(buffer, force, viewportY, terminal, scrollbarOpacity).
    const viewportY = typeof args[2] === 'number' ? (args[2] as number) : 0;
    const forced = args[1] === true;
    if (viewportY > 0 && !forced) {
      const moved = viewportY !== state.lastViewportY;
      state.lastViewportY = viewportY;
      const now = state.now();
      if (!moved && now - state.lastScrolledPaint < SCROLLED_PAINT_INTERVAL_MS) {
        return undefined;
      }
      state.lastScrolledPaint = now;
    } else {
      state.lastViewportY = 0;
    }
    return real.apply(this, args);
  };
  gates.set(terminal as object, state);
  return state;
}

/** Paint only while the terminal has something to paint into. */
export function setTerminalPainting(
  terminal: PaintableTerminal | undefined | null,
  painting: boolean,
): void {
  if (!terminal) return;
  const state = attach(terminal);
  if (state) state.painting = painting;
}
