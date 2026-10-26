// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from 'ghostty-web';
import { loadTerminalGhostty } from '../ghosttyInstance';
import { captureDocumentListeners } from '../documentListenerScope';


beforeAll(() => {
  // ghostty-web only reads local wasm paths through Bun.file under Node.
  (globalThis as Record<string, unknown>).Bun = {
    file: (p: string) => ({
      exists: async () => true,
      arrayBuffer: async () => {
        const b = readFileSync(p);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    }),
  };
});
afterEach(() => vi.restoreAllMocks());

/** Document listeners registered and not yet removed, by identity. */
function trackLive() {
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

async function openAndDispose(release: boolean) {
  // Real ghostty-web needs a 2d context; a no-op one is enough for open/dispose.
  const ctx = new Proxy({}, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }) : () => undefined),
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  const live = trackLive();
  const term = new Terminal({ ghostty: await loadTerminalGhostty() });
  const host = document.body.appendChild(document.createElement('div'));
  const { release: releaseListeners } = captureDocumentListeners(() => term.open(host));
  term.dispose();
  if (release) releaseListeners();
  return live.size;
}

describe('captureDocumentListeners with the real ghostty-web Terminal', () => {
  // Upstream's ghostty-web patch (#1818) now removes its own listeners on dispose; this release stays as a backstop.
  it('patched ghostty-web leaves no document listeners behind after dispose', async () => {
    expect(await openAndDispose(false)).toBe(0);
  });

  it('removes every one of them', async () => {
    expect(await openAndDispose(true)).toBe(0);
  });

  it('restores document.addEventListener and releases what ran before a throw', () => {
    const live = trackLive();
    const before = document.addEventListener;
    expect(() =>
      captureDocumentListeners(() => {
        document.addEventListener('click', () => {});
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(document.addEventListener).toBe(before);
    expect(live.size).toBe(0);
  });
});
