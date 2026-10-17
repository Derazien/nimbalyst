import * as fs from 'fs/promises';

/**
 * Process-wide ceiling on fs operations started for workspace file events.
 *
 * Every subscribed session reacts to every file event, and a program that only
 * reads thousands of files (a grep, a scan, an indexer) emits one event per
 * file when last-access updates are on. Unbounded, that was 8,004 open handles
 * at once, which hit the CRT descriptor cap and failed unrelated reads with
 * EMFILE. 100 keeps the thread pool busy and stays far below that cap; excess
 * work waits in a FIFO queue and nothing is dropped.
 */
export const MAX_CONCURRENT_WATCHER_FS_OPS = 100;

export interface FsLimiter {
  /** Runs `fn` once a slot is free. `fn` never starts synchronously. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export function createFsLimiter(limit: number): FsLimiter {
  let active = 0;
  let queue: Array<() => void> = [];
  let head = 0;

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => queue.push(resolve));
  };

  const release = (): void => {
    if (head >= queue.length) {
      active--;
      return;
    }
    // Hand the slot straight to the next waiter; `active` stays the same.
    const next = queue[head++];
    if (head === queue.length) {
      queue = [];
      head = 0;
    } else if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    next();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() { return active; },
    get waiting() { return queue.length - head; },
  };
}

const watcherFsLimiter = createFsLimiter(MAX_CONCURRENT_WATCHER_FS_OPS);

/** Run one fs operation through the shared watcher limit. */
export function runWithFsLimit<T>(fn: () => Promise<T>): Promise<T> {
  return watcherFsLimiter.run(fn);
}

export interface WatchedFileStat {
  size: number;
  mtimeMs: number;
}

export type WatchedTextResult =
  | { status: 'text'; content: string }
  | { status: 'binary' }
  | { status: 'error' };

/**
 * Requests for the same path share one operation until that operation actually
 * starts (stat or readFile issued). Joining is cut off at that point because a
 * request that arrives later may follow a write the running operation will not
 * see; it gets its own operation and so never receives stale content.
 * Sessions fan out from one bus event synchronously and the limiter never
 * starts work synchronously, so they all join the same operation.
 */
function shareUntilStarted<T>(ops: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const joined = ops.get(key);
  if (joined) return joined;
  const op: Promise<T> = runWithFsLimit(() => {
    if (ops.get(key) === op) ops.delete(key);
    return work();
  });
  ops.set(key, op);
  return op;
}

const statOps = new Map<string, Promise<WatchedFileStat | null>>();
const readOps = new Map<string, Promise<WatchedTextResult>>();

/** Size and mtime of a file, or null when it cannot be stat'ed. */
export function statWatchedFile(filePath: string): Promise<WatchedFileStat | null> {
  return shareUntilStarted(statOps, filePath, async () => {
    try {
      const stat = await fs.stat(filePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  });
}

/**
 * UTF-8 content of a file. `binary` means it holds a NUL byte (extensionless
 * binaries such as browser caches and SQLite journals), `error` means it could
 * not be read now. Size policy belongs to the caller, which has the stat.
 */
export function readWatchedText(filePath: string): Promise<WatchedTextResult> {
  return shareUntilStarted(readOps, filePath, async (): Promise<WatchedTextResult> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.includes('\0') ? { status: 'binary' } : { status: 'text', content };
    } catch {
      return { status: 'error' };
    }
  });
}
