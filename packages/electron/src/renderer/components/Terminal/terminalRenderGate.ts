/**
 * Keep a terminal that has no visible area from painting.
 *
 * `ghostty-web` renders on EVERY animation frame for as long as the terminal is
 * open, with no check for "did anything change" and no check for "am I on
 * screen" (its loop: `render(...); requestAnimationFrame(again)`). The Claude
 * CLI raw-terminal drawer deliberately stays mounted while collapsed so the PTY
 * survives, so a collapsed drawer kept repainting a zero-size canvas 60 times a
 * second. Measured in a live window: 27 s of work in 46 s, 11 s of it in
 * `fillText`, with no terminal output at all. That left the renderer thread with
 * no headroom, and switching projects on top of it felt like a freeze.
 *
 * The library exposes no pause API (only `open` and `dispose`, and disposing
 * would tear down the live TUI), so the gate replaces the renderer's `render`
 * with a no-op while the terminal is hidden and puts the original back when it
 * is shown. Everything else keeps running: output still reaches the terminal
 * buffer, so the first frame after it is shown paints the current screen.
 *
 * Feature-detected on purpose: if a future ghostty changes this shape, the gate
 * becomes a no-op and we are back to today's behavior rather than a crash.
 */

interface PaintableTerminal {
  renderer?: { render?: unknown };
}

/** The real `render` of every terminal we have paused, keyed by the terminal. */
const pausedRenderers = new WeakMap<object, unknown>();

export function setTerminalPainting(
  terminal: PaintableTerminal | undefined | null,
  painting: boolean,
): void {
  const renderer = terminal?.renderer;
  if (!renderer || typeof renderer.render !== 'function') return;

  const original = pausedRenderers.get(terminal as object);
  if (painting) {
    if (!original) return;
    renderer.render = original;
    pausedRenderers.delete(terminal as object);
    return;
  }
  if (original) return;
  pausedRenderers.set(terminal as object, renderer.render);
  renderer.render = () => {};
}
