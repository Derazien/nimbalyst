/**
 * Main's own copy of a Claude CLI terminal's screen.
 *
 * The renderer's terminal emulator is the only other model of the screen, and it exists only
 * while the CLI drawer has a measurable box: a drawer that has been collapsed since the view
 * mounted never builds one, so main (which answers the plan dialog by keystroke and tracks the
 * permission-mode chip from screen text) would read a stale screen. This feeds the same raw PTY
 * bytes to the same VT engine the renderer uses (ghostty-web), headless: no DOM, no canvas.
 *
 * One Ghostty instance per terminal, never shared: freeing a terminal inside a shared instance
 * corrupts it (coder/ghostty-web#141), so `dispose()` only drops references. The WASM bytes are
 * read and compiled once per process; each terminal instantiates its own copy (~7 MB).
 *
 * Fails soft: any exception, or a WASM file that cannot be found, disables the shadow (logged
 * once) and `lines()` returns null so callers fall back to the lines the renderer pushes.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { Ghostty, type GhosttyTerminal } from 'ghostty-web';

let compiled: WebAssembly.Module | null | undefined;

/** Where `ghostty-vt.wasm` may live, most specific first (see `loadModule`). */
function defaultWasmCandidates(): string[] {
  const candidates: string[] = [
    // Packaged app and built dev: main is out/main/index.js and the renderer build copies the
    // wasm to out/renderer (inside app.asar when packaged; fs reads through it). Alternate
    // outDirs (out2/main) keep the same sibling layout.
    path.join(__dirname, '..', 'renderer', 'ghostty-vt.wasm'),
    path.join(__dirname, '..', '..', 'renderer', 'ghostty-vt.wasm'),
  ];
  try {
    // Dev from source, and unit tests: the installed package exports the file.
    candidates.push(createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm'));
  } catch {
    // Not resolvable from here (packaged builds do not ship node_modules/ghostty-web).
  }
  return candidates;
}

function loadModule(wasmPaths?: readonly string[]): WebAssembly.Module | null {
  if (wasmPaths === undefined && compiled !== undefined) return compiled;
  let module: WebAssembly.Module | null = null;
  const tried: string[] = [];
  for (const candidate of wasmPaths ?? defaultWasmCandidates()) {
    try {
      module = new WebAssembly.Module(readFileSync(candidate));
      break;
    } catch (err) {
      tried.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (!module) {
    console.warn(`[ClaudeCliShadowScreen] ghostty-vt.wasm not loadable, shadow screen off. Tried: ${tried.join('; ')}`);
  }
  if (wasmPaths === undefined) compiled = module;
  return module;
}

export class ClaudeCliShadowScreen {
  private terminal: GhosttyTerminal | null;
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number, wasmPaths?: readonly string[]) {
    this.cols = cols;
    this.rows = rows;
    this.terminal = null;
    const module = loadModule(wasmPaths);
    if (!module) return;
    try {
      // Ghostty.load() reads `self`, which Node lacks; construct from the instance instead.
      const instance = new WebAssembly.Instance(module, { env: { log: () => {} } });
      this.terminal = new Ghostty(instance).createTerminal(cols, rows, { scrollbackLimit: 0 });
    } catch (err) {
      this.fail('create', err);
    }
  }

  /** False once the shadow is off (never loaded, failed, or disposed); callers then use the renderer's lines. */
  get live(): boolean {
    return this.terminal !== null;
  }

  write(data: string): void {
    if (!this.terminal) return;
    try {
      this.terminal.write(data);
    } catch (err) {
      this.fail('write', err);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.terminal || (cols === this.cols && rows === this.rows)) return;
    try {
      this.terminal.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
    } catch (err) {
      this.fail('resize', err);
    }
  }

  /** The visible screen, one string per row (not trimmed, like the renderer's `translateToString(false)`); null when off. */
  lines(): string[] | null {
    if (!this.terminal) return null;
    try {
      const out: string[] = [];
      for (let y = 0; y < this.rows; y += 1) {
        const cells = this.terminal.getLine(y);
        let text = '';
        if (cells) {
          for (const cell of cells) {
            // A wide character's second cell has width 0 and carries no text of its own.
            if (cell.width === 0) continue;
            text += cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint);
          }
        }
        out.push(text);
      }
      return out;
    } catch (err) {
      this.fail('lines', err);
      return null;
    }
  }

  /** Drops the references. Deliberately no `free()`: see the file header. */
  dispose(): void {
    this.terminal = null;
  }

  private fail(what: string, err: unknown): void {
    console.warn(`[ClaudeCliShadowScreen] ${what} failed, shadow screen off:`, err);
    this.terminal = null;
  }
}
