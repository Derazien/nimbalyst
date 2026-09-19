/**
 * Where the genuine `kimi` CLI keeps a session on disk, and how Nimbalyst
 * finds and follows it.
 *
 * kimi 0.43.1 creates a session only on the first prompt, and `kimi -S <id>`
 * refuses an id it has never seen, so Nimbalyst cannot pick the id up front
 * the way it passes `--session-id` to claude. Instead it watches
 * `~/.kimi-code/session_index.jsonl` for the row kimi appends for the new
 * session (`{sessionId, sessionDir, workDir}`), then tails that session's
 * `agents/main/wire.jsonl` event log.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export function kimiHomeDir(homedir: string = os.homedir()): string {
  return path.join(homedir, '.kimi-code');
}

export function kimiSessionIndexPath(homedir?: string): string {
  return path.join(kimiHomeDir(homedir), 'session_index.jsonl');
}

export function kimiWirePath(sessionDir: string): string {
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

export interface KimiSessionIndexRow {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

/** Same folder, however it is spelled (kimi writes forward slashes). */
export function sameKimiWorkDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readFrom(filePath: string, offset: number): Buffer {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseIndexRows(text: string): KimiSessionIndexRow[] {
  const rows: KimiSessionIndexRow[] = [];
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row.sessionId === 'string' && typeof row.sessionDir === 'string' && typeof row.workDir === 'string') {
        rows.push(row);
      }
    } catch {
      // partial or foreign line
    }
  }
  return rows;
}

/** Byte length of the index now, so a later search only sees rows added after it. */
export function kimiSessionIndexMark(indexPath: string): number {
  return fileSize(indexPath);
}

/**
 * The first session kimi added to the index after `sinceOffset` for this
 * working folder that nobody has claimed yet, or null.
 */
export function findNewKimiSession(input: {
  indexPath: string;
  sinceOffset: number;
  workDir: string;
  isClaimed: (kimiSessionId: string) => boolean;
}): KimiSessionIndexRow | null {
  const rows = parseIndexRows(readFrom(input.indexPath, input.sinceOffset).toString('utf8'));
  return rows.find((row) => sameKimiWorkDir(row.workDir, input.workDir) && !input.isClaimed(row.sessionId)) ?? null;
}

/** The directory of a known kimi session, for resume. */
export function findKimiSessionDir(indexPath: string, kimiSessionId: string): string | null {
  const rows = parseIndexRows(readFrom(indexPath, 0).toString('utf8'));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sessionId === kimiSessionId) return rows[i].sessionDir;
  }
  return null;
}

/**
 * Tails an append-only JSONL file by byte offset, handing over each complete
 * line once. A trailing partial line waits for its newline; a file that does
 * not exist yet is simply empty.
 */
export class JsonlFollower {
  private offset: number;
  private partial: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly onLine: (line: string) => void,
    options: { startAtEnd?: boolean } = {},
  ) {
    this.offset = options.startAtEnd ? fileSize(filePath) : 0;
  }

  /** Read whatever was appended since the last poll. */
  poll(): void {
    const chunk = readFrom(this.filePath, this.offset);
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    let data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline !== -1) {
      const line = data.subarray(0, newline).toString('utf8');
      data = data.subarray(newline + 1);
      try {
        this.onLine(line);
      } catch (error) {
        console.warn('[JsonlFollower] line handler failed:', error);
      }
      newline = data.indexOf(0x0a);
    }
    this.partial = Buffer.from(data);
  }

  start(intervalMs = 200): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
