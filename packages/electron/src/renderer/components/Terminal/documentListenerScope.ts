/**
 * Undo the `document` listeners ghostty-web leaves behind when a terminal is
 * disposed.
 *
 * Terminal.open() registers listeners on `document` that dispose() never
 * removes:
 *  - SelectionManager adds an ANONYMOUS `mousedown` arrow (it cannot be
 *    removed by anyone who does not hold the reference),
 *  - Terminal.dispose() clears `isOpen` before cleanupComponents() checks
 *    `this.isOpen` to remove the `mouseup` handler, so that one is skipped.
 *
 * A `document` listener lives as long as the page, and each one closes over its
 * Terminal / SelectionManager, which reach the terminal's dedicated
 * WebAssembly.Instance (see ghosttyInstance.ts). Every disposed terminal was
 * therefore retained forever. Each instance reserves ~8-10 GiB of address
 * space, so after ~120 opens V8 refused to allocate another one and every
 * terminal showed "Failed to initialize terminal: Failed to fetch" (observed
 * live 2026-10-11, 123 live WebAssembly.Memory objects for 3 canvases).
 *
 * `captureDocumentListeners` records what the callback registers on `document`
 * and hands back a function that removes all of it. TerminalPanel calls it
 * just before terminal.dispose(), so a dispose() that throws cannot strand the
 * listeners. Removing a listener already removed is a no-op.
 */
export function captureDocumentListeners<T>(
  run: () => T,
  doc: Document = document,
): { result: T; release: () => void } {
  const captured: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  const hadOwnAdd = Object.prototype.hasOwnProperty.call(doc, 'addEventListener');
  const originalOwnAdd = hadOwnAdd ? doc.addEventListener : undefined;
  const add = doc.addEventListener;

  doc.addEventListener = function (
    this: Document,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (listener) captured.push({ type, listener, options });
    return add.call(this, type, listener as EventListenerOrEventListenerObject, options);
  } as typeof doc.addEventListener;

  const release = () => {
    for (const { type, listener, options } of captured.splice(0)) {
      doc.removeEventListener(type, listener, options);
    }
  };

  try {
    return { result: run(), release };
  } catch (error) {
    release();
    throw error;
  } finally {
    if (hadOwnAdd) doc.addEventListener = originalOwnAdd as typeof doc.addEventListener;
    else delete (doc as { addEventListener?: unknown }).addEventListener;
  }
}
