// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as realFs from 'fs/promises';

const { readDelayMs, accessProbe } = vi.hoisted(() => ({
  readDelayMs: { value: 0 },
  accessProbe: { inFlight: 0, peak: 0 },
}));

// Real files, counted calls: the wrapper delegates to the real fs and only
// records how often it was reached. The read delay applies AFTER the bytes
// are read, so a slow read hands back what the file held when it started.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
    access: vi.fn(async (...args: Parameters<typeof actual.access>) => {
      accessProbe.inFlight++;
      accessProbe.peak = Math.max(accessProbe.peak, accessProbe.inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      accessProbe.inFlight--;
      return actual.access(...args);
    }),
    readFile: vi.fn(async (...args: any[]) => {
      const data = await (actual.readFile as any)(...args);
      if (readDelayMs.value) await new Promise(resolve => setTimeout(resolve, readDelayMs.value));
      return data;
    }),
  };
});

import * as fs from 'fs/promises';
import { pathExistsAfterRename } from '../pathExistsAfterRename';
import {
  createFsLimiter,
  MAX_CONCURRENT_WATCHER_FS_OPS,
  readWatchedText,
  statWatchedFile,
} from '../WatchedFileReader';

describe('createFsLimiter', () => {
  it('never runs more than the limit at once and runs everything queued, in order', async () => {
    const limiter = createFsLimiter(3);
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];

    const tasks = Array.from({ length: 40 }, (_, i) => limiter.run(async () => {
      started.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return i;
    }));

    const results = await Promise.all(tasks);

    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(started).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = createFsLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    expect(limiter.active).toBe(0);
  });

  it('uses a ceiling well under the Windows descriptor cap', () => {
    expect(MAX_CONCURRENT_WATCHER_FS_OPS).toBe(100);
  });
});

describe('shared watcher reads', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    readDelayMs.value = 0;
    dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'watched-reader-'));
  });

  afterEach(async () => {
    await realFs.rm(dir, { recursive: true, force: true });
  });

  it('lets many sessions share one read of the same file', async () => {
    const file = path.join(dir, 'notes.md');
    await realFs.writeFile(file, 'hello');

    const results = await Promise.all(Array.from({ length: 50 }, () => readWatchedText(file)));

    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(results.every(r => r.status === 'text' && r.content === 'hello')).toBe(true);
  });

  it('lets many sessions share one stat of the same file', async () => {
    const file = path.join(dir, 'notes.md');
    await realFs.writeFile(file, 'hello');

    const results = await Promise.all(Array.from({ length: 50 }, () => statWatchedFile(file)));

    expect(fs.stat).toHaveBeenCalledTimes(1);
    expect(results.every(r => r?.size === 5)).toBe(true);
  });

  it('does not serve stale content to a request that arrives after the read began', async () => {
    const file = path.join(dir, 'notes.md');
    await realFs.writeFile(file, 'old');
    readDelayMs.value = 40;

    const first = readWatchedText(file);
    // Let the first read start and capture 'old', then change the file.
    await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalledTimes(1));
    await realFs.writeFile(file, 'new');
    const second = readWatchedText(file);

    expect(await first).toEqual({ status: 'text', content: 'old' });
    expect(await second).toEqual({ status: 'text', content: 'new' });
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });

  it('reports an access-only touch as an unchanged stat', async () => {
    const file = path.join(dir, 'old.json');
    await realFs.writeFile(file, '{}');
    const longAgo = new Date(Date.now() - 86_400_000);
    await realFs.utimes(file, longAgo, longAgo);
    const before = await statWatchedFile(file);

    // What a grep over the file does on a last-access-enabled volume.
    await realFs.utimes(file, new Date(), longAgo);
    const after = await statWatchedFile(file);

    expect(after).toEqual(before);
  });

  it('keeps a burst of rename probes under the shared limit', async () => {
    const file = path.join(dir, 'renamed.md');
    await realFs.writeFile(file, 'x');
    accessProbe.inFlight = 0;
    accessProbe.peak = 0;

    const results = await Promise.all(Array.from({ length: 400 }, () => pathExistsAfterRename(file)));

    expect(results.every(Boolean)).toBe(true);
    expect(accessProbe.peak).toBeGreaterThan(1);
    expect(accessProbe.peak).toBeLessThanOrEqual(MAX_CONCURRENT_WATCHER_FS_OPS);
  });

  it('tells binary content and unreadable files apart', async () => {
    const binary = path.join(dir, 'journal');
    await realFs.writeFile(binary, Buffer.from('SQLite\0\0journal'));

    expect(await readWatchedText(binary)).toEqual({ status: 'binary' });
    expect(await readWatchedText(path.join(dir, 'missing.txt'))).toEqual({ status: 'error' });
    expect(await statWatchedFile(path.join(dir, 'missing.txt'))).toBeNull();
  });
});
