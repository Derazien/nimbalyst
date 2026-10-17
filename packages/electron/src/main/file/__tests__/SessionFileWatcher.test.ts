import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FileSnapshotCache } from '../FileSnapshotCache';
import type { WorkspaceEventListener } from '../WorkspaceEventBus';

// ---------------------------------------------------------------------------
// Hoisted shared state for mocks (vi.hoisted runs before vi.mock factories)
// ---------------------------------------------------------------------------

const {
  capturedListeners,
  subscriberCountRef,
  mockReadFile,
  mockStat,
} = vi.hoisted(() => ({
  capturedListeners: new Map<string, WorkspaceEventListener>(),
  subscriberCountRef: { value: 0 },
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock WorkspaceEventBus — capture the listener passed to subscribe() so we
// can invoke it directly in tests, exactly like the old chokidar mock did.
// ---------------------------------------------------------------------------

vi.mock('../WorkspaceEventBus', () => ({
  subscribe: vi.fn(async (_wp: string, id: string, listener: WorkspaceEventListener) => {
    capturedListeners.set(id, listener);
    subscriberCountRef.value++;
  }),
  unsubscribe: vi.fn((_wp: string, id: string) => {
    capturedListeners.delete(id);
    subscriberCountRef.value--;
  }),
  getSubscriberIds: vi.fn(() => [...capturedListeners.keys()]),
  getBusEntryCount: vi.fn(() => (capturedListeners.size > 0 ? 1 : 0)),
  getRefCount: vi.fn(() => subscriberCountRef.value),
  resetBus: vi.fn(() => {
    capturedListeners.clear();
    subscriberCountRef.value = 0;
  }),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  stat: (...args: any[]) => mockStat(...args),
}));

import * as bus from '../WorkspaceEventBus';
import { MAX_CONCURRENT_WATCHER_FS_OPS } from '../WatchedFileReader';

import {
  SessionFileWatcher,
  getSharedWatcherRefCount,
  getSharedWatcherSessionIds,
  resetSharedWatchers,
} from '../SessionFileWatcher';

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createMockCache(): FileSnapshotCache {
  return {
    getBeforeState: vi.fn(),
    updateSnapshot: vi.fn(),
    removeSnapshot: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    getStats: vi.fn(() => ({ fileCount: 0, totalBytes: 0, sessionId: null, isGitRepo: false })),
  } as any;
}

/** Map of file path -> content (or Error to reject). Used by mockReadFile. */
let mockFileContents: Record<string, string | Error> = {};

function setMockFileContent(filePath: string, content: string | Error): void {
  mockFileContents[filePath] = content;
}

/** Helper to fire a change event for all captured listeners */
function fireChange(filePath: string): void {
  for (const listener of capturedListeners.values()) {
    listener.onChange(filePath);
  }
}

function fireAdd(filePath: string): void {
  for (const listener of capturedListeners.values()) {
    listener.onAdd(filePath);
  }
}

function fireUnlink(filePath: string): void {
  for (const listener of capturedListeners.values()) {
    listener.onUnlink(filePath);
  }
}

describe('SessionFileWatcher', () => {
  const workspacePath = '/test/workspace';
  const sessionId = 'test-session-1';

  beforeEach(() => {
    vi.clearAllMocks();
    capturedListeners.clear();
    subscriberCountRef.value = 0;

    mockFileContents = {};
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath in mockFileContents) {
        const value = mockFileContents[filePath];
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(value);
      }
      if (filePath.endsWith('.gitignore')) {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve('');
    });
    mockStat.mockResolvedValue({ size: 100 });
  });

  describe('start/stop lifecycle', () => {
    it('starts and stops with active state updates', async () => {
      const watcher = new SessionFileWatcher();
      const cache = createMockCache();

      await watcher.start(workspacePath, sessionId, cache);
      expect(watcher.isActive()).toBe(true);

      await watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('handles stop when not started', async () => {
      const watcher = new SessionFileWatcher();
      await watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('shared watcher behavior', () => {
    it('shares one bus entry across sessions for the same workspace', async () => {
      const watcher1 = new SessionFileWatcher();
      const watcher2 = new SessionFileWatcher();

      await watcher1.start(workspacePath, 'session-1', createMockCache());
      await watcher2.start(workspacePath, 'session-2', createMockCache());

      expect(bus.subscribe).toHaveBeenCalledTimes(2);
      expect(getSharedWatcherRefCount(workspacePath)).toBe(2);
      expect(getSharedWatcherSessionIds(workspacePath).sort()).toEqual(['session-1', 'session-2']);

      await watcher1.stop();
      expect(bus.unsubscribe).toHaveBeenCalledTimes(1);

      await watcher2.stop();
      expect(bus.unsubscribe).toHaveBeenCalledTimes(2);
    });

    it('dispatches change events to all session listeners', async () => {
      const cache1 = createMockCache();
      const cache2 = createMockCache();
      (cache1.getBeforeState as any).mockResolvedValue('before');
      (cache2.getBeforeState as any).mockResolvedValue('before');
      setMockFileContent('/test/workspace/src/file.ts', 'after');

      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const watcher1 = new SessionFileWatcher();
      const watcher2 = new SessionFileWatcher();

      await watcher1.start(workspacePath, 'session-1', cache1, cb1);
      await watcher2.start(workspacePath, 'session-2', cache2, cb2);

      // Fire change through the bus listener directly
      fireChange('/test/workspace/src/file.ts');
      await flush();

      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();

      await watcher1.stop();
      await watcher2.stop();
    });
  });

  describe('change event handling', () => {
    it('emits watcher edit payload and updates cache when content changes', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('original content');
      setMockFileContent('/test/workspace/src/file.ts', 'modified content');

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireChange('/test/workspace/src/file.ts');
      await flush();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath,
          filePath: '/test/workspace/src/file.ts',
          beforeContent: 'original content',
          timestamp: expect.any(Number),
        })
      );
      expect(cache.updateSnapshot).toHaveBeenCalledWith('/test/workspace/src/file.ts', 'modified content');

      await watcher.stop();
    });

    it('does not emit event when content is unchanged', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('same content');
      setMockFileContent('/test/workspace/src/file.ts', 'same content');

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireChange('/test/workspace/src/file.ts');
      await flush();

      expect(callback).not.toHaveBeenCalled();
      expect(cache.updateSnapshot).toHaveBeenCalledWith('/test/workspace/src/file.ts', 'same content');

      await watcher.stop();
    });

    it('logs no-op skip with reason when content is unchanged', async () => {
      const { logger } = await import('../../utils/logger');
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('same content');
      setMockFileContent('/test/workspace/src/file.ts', 'same content');

      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache);

      fireChange('/test/workspace/src/file.ts');
      await flush();

      expect(logger.main.debug).toHaveBeenCalledWith(
        '[SessionFileWatcher] No-op skip (content unchanged):',
        expect.objectContaining({
          workspacePath,
          filePath: '/test/workspace/src/file.ts',
          sessionId,
          reason: 'no_content_change',
        })
      );

      await watcher.stop();
    });

    it('skips binary files', async () => {
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();

      await watcher.start(workspacePath, sessionId, cache, callback);

      fireChange('/test/workspace/image.png');

      expect(cache.getBeforeState).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      await watcher.stop();
    });

    it('never snapshots extensionless binary content (#1599: Chrome profile churn)', async () => {
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      const journal = '/test/workspace/audit/prof-1/Default/History-journal';
      setMockFileContent(journal, 'SQLite\u0000\u0000journal');

      await watcher.start(workspacePath, sessionId, cache, callback);
      fireChange(journal);
      fireAdd(journal);
      await flush();

      expect(callback).not.toHaveBeenCalled();
      expect(cache.updateSnapshot).not.toHaveBeenCalled();

      await watcher.stop();
    });

    it('does not read files over the snapshot size cap', async () => {
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      mockStat.mockResolvedValue({ size: 5_000_000 });

      await watcher.start(workspacePath, sessionId, cache, callback);
      fireChange('/test/workspace/audit/prof-1/Default/Cache/Cache_Data/f_000001');
      await flush();

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      await watcher.stop();
    });
  });

  describe('add event handling', () => {
    it('emits add payload with empty before content for truly new files', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue(null);
      setMockFileContent('/test/workspace/src/new-file.ts', 'new file content');

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireAdd('/test/workspace/src/new-file.ts');
      await flush();

      expect(cache.getBeforeState).toHaveBeenCalledWith('/test/workspace/src/new-file.ts');
      expect(cache.updateSnapshot).toHaveBeenCalledWith('/test/workspace/src/new-file.ts', 'new file content');
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath,
          filePath: '/test/workspace/src/new-file.ts',
          beforeContent: '',
          timestamp: expect.any(Number),
        })
      );

      await watcher.stop();
    });

    it('uses cached before content for atomic rewrites (rename events)', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('original content');
      setMockFileContent('/test/workspace/src/file.ts', 'modified content');

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireAdd('/test/workspace/src/file.ts');
      await flush();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath,
          filePath: '/test/workspace/src/file.ts',
          beforeContent: 'original content',
          timestamp: expect.any(Number),
        })
      );
      expect(cache.updateSnapshot).toHaveBeenCalledWith('/test/workspace/src/file.ts', 'modified content');

      await watcher.stop();
    });

    it('skips add event when cached content matches new content', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('same content');
      setMockFileContent('/test/workspace/src/file.ts', 'same content');

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireAdd('/test/workspace/src/file.ts');
      await flush();

      expect(callback).not.toHaveBeenCalled();

      await watcher.stop();
    });

    it('skips binary files on add', async () => {
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();

      await watcher.start(workspacePath, sessionId, cache, callback);

      fireAdd('/test/workspace/file.jpg');

      expect(callback).not.toHaveBeenCalled();

      await watcher.stop();
    });
  });

  describe('unlink event handling', () => {
    it('does not remove snapshot on unlink (preserves cache for atomic rewrites)', async () => {
      const cache = createMockCache();
      const watcher = new SessionFileWatcher();

      await watcher.start(workspacePath, sessionId, cache);

      fireUnlink('/test/workspace/src/deleted.ts');

      // Cache entry is intentionally preserved so that subsequent
      // atomic write add events can provide correct before-content
      expect(cache.removeSnapshot).not.toHaveBeenCalled();

      await watcher.stop();
    });
  });

  describe('inactive state', () => {
    it('does not process events after stop', async () => {
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();

      await watcher.start(workspacePath, sessionId, cache, callback);

      // Capture the listener before stop removes it from the bus
      const listener = capturedListeners.get(sessionId);

      await watcher.stop();

      // Events fired after stop should be ignored by the watcher
      if (listener) {
        listener.onChange('/test/workspace/src/file.ts');
        listener.onAdd('/test/workspace/src/new.ts');
      }
      await flush();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('read storms and access-only events', () => {
    const oldFile = '/test/workspace/docs/old.json';
    const editedFile = '/test/workspace/src/edited.ts';

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Freeze the clock only; the real timers keep driving flush(). */
    function freezeClock(): number {
      vi.useFakeTimers({ toFake: ['Date'] });
      const startMs = Date.parse('2026-10-17T10:00:00Z');
      vi.setSystemTime(startMs);
      return startMs;
    }

    it('does not read a file last written before the session started', async () => {
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('original');
      setMockFileContent(oldFile, 'different');
      mockStat.mockResolvedValue({ size: 9, mtimeMs: Date.now() - 60_000 });

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      fireChange(oldFile);
      fireChange(oldFile);
      fireChange(oldFile);
      await flush();

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      await watcher.stop();
    });

    it('does not read again when a later event leaves mtime and size alone', async () => {
      const startMs = freezeClock();
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('original');
      setMockFileContent(editedFile, 'edited');
      mockStat.mockResolvedValue({ size: 6, mtimeMs: startMs + 500 });

      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      vi.setSystemTime(startMs + 10_000);
      fireChange(editedFile);
      await flush();
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);

      // A reader touching the file later changes only its access time.
      vi.setSystemTime(startMs + 20_000);
      fireChange(editedFile);
      await flush();
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);

      await watcher.stop();
    });

    it('re-reads when the previous read was too close to the mtime to trust', async () => {
      const startMs = freezeClock();
      const cache = createMockCache();
      (cache.getBeforeState as any).mockResolvedValue('original');
      setMockFileContent(editedFile, 'edited');
      mockStat.mockResolvedValue({ size: 6, mtimeMs: startMs + 500 });

      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, vi.fn());

      // Two writes inside one mtime tick with the same size would look identical.
      vi.setSystemTime(startMs + 600);
      fireChange(editedFile);
      await flush();
      vi.setSystemTime(startMs + 700);
      fireChange(editedFile);
      await flush();

      expect(mockReadFile).toHaveBeenCalledTimes(2);

      await watcher.stop();
    });

    it('still attributes an edit after session start, its revert, and a revert that keeps an old mtime', async () => {
      const startMs = freezeClock();
      const cache = createMockCache();
      const callback = vi.fn();
      const watcher = new SessionFileWatcher();
      await watcher.start(workspacePath, sessionId, cache, callback);

      // Edit A -> B.
      (cache.getBeforeState as any).mockResolvedValue('A');
      setMockFileContent(editedFile, 'B');
      mockStat.mockResolvedValue({ size: 1, mtimeMs: startMs + 100 });
      vi.setSystemTime(startMs + 200);
      fireChange(editedFile);
      await flush();
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: editedFile, beforeContent: 'A' }));

      // Revert B -> A.
      (cache.getBeforeState as any).mockResolvedValue('B');
      setMockFileContent(editedFile, 'A');
      mockStat.mockResolvedValue({ size: 1, mtimeMs: startMs + 5000 });
      vi.setSystemTime(startMs + 6000);
      fireChange(editedFile);
      await flush();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: editedFile, beforeContent: 'B' }));

      // A -> longer content restored with `cp -p`: mtime predates the session, size differs.
      (cache.getBeforeState as any).mockResolvedValue('A');
      setMockFileContent(editedFile, 'A2');
      mockStat.mockResolvedValue({ size: 2, mtimeMs: startMs - 60_000 });
      vi.setSystemTime(startMs + 7000);
      fireChange(editedFile);
      await flush();
      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: editedFile, beforeContent: 'A' }));

      await watcher.stop();
    });

    it('bounds simultaneous fs work across sessions and still reports every change', async () => {
      let inFlight = 0;
      let peak = 0;
      const tracked = async <T>(value: T): Promise<T> => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight--;
        return value;
      };
      mockStat.mockImplementation(() => tracked({ size: 10, mtimeMs: Date.now() }));
      mockReadFile.mockImplementation((filePath: string) => tracked(`after ${filePath}`));

      const callbacks = [vi.fn(), vi.fn(), vi.fn()];
      const watchers = callbacks.map(() => new SessionFileWatcher());
      for (const [i, watcher] of watchers.entries()) {
        const cache = createMockCache();
        (cache.getBeforeState as any).mockResolvedValue('before');
        await watcher.start(workspacePath, `storm-session-${i}`, cache, callbacks[i]);
      }

      const paths = Array.from({ length: 500 }, (_, i) => `/test/workspace/src/file-${i}.ts`);
      for (const filePath of paths) fireChange(filePath);

      await vi.waitFor(() => {
        for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(500);
      }, { timeout: 10_000 });

      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_WATCHER_FS_OPS);
      for (const callback of callbacks) {
        const reported = new Set(callback.mock.calls.map(([event]) => event.filePath));
        expect(reported).toEqual(new Set(paths));
      }
      // Sessions share one read per file instead of one each.
      expect(mockReadFile).toHaveBeenCalledTimes(500);

      for (const watcher of watchers) await watcher.stop();
    });
  });
});
