import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  privateFileSignature,
  statSignature,
  writePrivateFile,
} from "./privateFile";

/**
 * The one in-memory copy of each settings file in this process.
 *
 * conf, under electron-store, reads and parses the whole file on every get and
 * rewrites it with fsync on every set, all on the main thread. On a busy disk
 * each of those holds the window for seconds: one periodic session-state save
 * spent 3.5 s creating a lock file and 2.1 s in fsync. Here a read costs one
 * metadata check while the file is unchanged, and files registered for
 * background writes reach the disk off the main thread, in order, and are
 * flushed synchronously on the way out.
 */

type SettingsData = Record<string, any>;

interface HeldSettings {
  data: SettingsData;
  /** Signature of the file on disk that `data` matches. */
  signature?: string;
  /** Changes made in memory, and how many of them are on disk. */
  changes: number;
  written: number;
  /** Present for files written in the background. */
  serialize?: (data: SettingsData) => string;
  timer?: NodeJS.Timeout;
  writing?: Promise<void>;
  retried?: boolean;
}

const WRITE_DELAY_MS = 100;
const RETRY_DELAY_MS = 5_000;
const held = new Map<string, HeldSettings>();
let exitHooked = false;

const pending = (entry: HeldSettings) => entry.changes > entry.written;

/** The held contents while they are current, else undefined. Copy before changing them. */
export function currentSettings(file: string): SettingsData | undefined {
  const entry = held.get(file);
  if (!entry) return undefined;
  if (pending(entry)) return entry.data;
  return entry.signature !== undefined &&
    entry.signature === privateFileSignature(file)
    ? entry.data
    : undefined;
}

/** Keep contents just read from disk. Take `signature` before the read. */
export function holdSettings(
  file: string,
  data: SettingsData,
  signature: string
): void {
  const entry = held.get(file);
  if (!entry) held.set(file, { data, signature, changes: 0, written: 0 });
  else if (!pending(entry)) Object.assign(entry, { data, signature });
}

/** The file was written some other way, so the next read loads it again. */
export function forgetSettings(file: string): void {
  const entry = held.get(file);
  if (entry && !pending(entry)) entry.signature = undefined;
}

/** From now on this file's changes are written off the main thread. */
export function writeSettingsInBackground(
  file: string,
  serialize: (data: SettingsData) => string
): void {
  const entry = held.get(file);
  if (entry) entry.serialize = serialize;
  else held.set(file, { data: {}, changes: 0, written: 0, serialize });
  if (!exitHooked) {
    exitHooked = true;
    // Backstop for exit paths that skip the explicit flush.
    process.once("exit", flushSettingsSync);
  }
}

export function isWrittenInBackground(file: string): boolean {
  return held.get(file)?.serialize !== undefined;
}

/** Replace a background-written file's contents; false when the caller must write it. */
export function replaceSettings(file: string, data: SettingsData): boolean {
  const entry = held.get(file);
  if (!entry?.serialize) return false;
  entry.data = data;
  entry.changes++;
  entry.retried = false;
  schedule(file, entry, WRITE_DELAY_MS);
  return true;
}

function schedule(file: string, entry: HeldSettings, delay: number): void {
  // A running write schedules the next one when it ends.
  if (entry.timer || entry.writing) return;
  entry.timer = setTimeout(() => start(file, entry), delay);
  entry.timer.unref?.();
}

function start(file: string, entry: HeldSettings): void {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.writing = write(file, entry).then((ok) => {
    entry.writing = undefined;
    if (!pending(entry)) return;
    if (ok) schedule(file, entry, WRITE_DELAY_MS);
    else if (!entry.retried) {
      // One retry; after that the next change or the exit flush tries again.
      entry.retried = true;
      schedule(file, entry, RETRY_DELAY_MS);
    }
  });
}

async function write(file: string, entry: HeldSettings): Promise<boolean> {
  const changes = entry.changes;
  const text = entry.serialize!(entry.data);
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fs.promises.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") {
      const existing = await fs.promises.lstat(file).catch(() => undefined);
      if (
        existing &&
        (!existing.isFile() ||
          existing.nlink !== 1 ||
          (existing.mode & 0o600) !== 0o600)
      )
        throw new Error("Refusing to replace an unsafe or read-only settings file");
    }
    // The exit flush may have stored these changes, or newer ones, already.
    if (entry.written >= changes) return true;
    await fs.promises.rename(temp, file);
    if (process.platform !== "win32") {
      const directory = await fs.promises.open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const stat = await fs.promises.lstat(file);
    if (entry.written < changes) {
      entry.written = changes;
      if (!pending(entry)) entry.signature = statSignature(stat);
    }
    return true;
  } catch (error) {
    console.warn(
      `[Settings] Background save of ${path.basename(file)} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Store every pending change now. For the way out, where blocking is acceptable. */
export function flushSettingsSync(): void {
  for (const [file, entry] of held) {
    if (!entry.serialize || !pending(entry)) continue;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    try {
      writePrivateFile(file, entry.serialize(entry.data));
      entry.written = entry.changes;
      entry.signature = privateFileSignature(file);
    } catch (error) {
      console.error(
        `[Settings] Could not save ${path.basename(file)} on exit:`,
        error
      );
    }
  }
}

/** Resolves once no background write is waiting or running. */
export async function settingsWritesSettled(): Promise<void> {
  for (;;) {
    const busy = [...held].filter(([, entry]) => entry.timer || entry.writing);
    if (!busy.length) return;
    for (const [file, entry] of busy) if (entry.timer) start(file, entry);
    await Promise.all(busy.map(([, entry]) => entry.writing));
  }
}
