import * as path from 'path';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import type { FileSnapshotCache } from './FileSnapshotCache';
import * as workspaceEventBus from './WorkspaceEventBus';
import { markKnownFileWrite } from './knownFileWrites';
import { readWatchedText, statWatchedFile, type WatchedFileStat } from './WatchedFileReader';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lock',
  '.wasm', '.node',
  '.pak', '.pdb', '.dat', '.bin', '.blockmap', '.asar', '.icns', '.appimage',
  '.dmg', '.deb', '.rpm', '.snap', '.msi', '.nupkg',
]);

/** Matches FileSnapshotCache's per-file cap; larger files are never snapshotted. */
const MAX_SNAPSHOT_FILE_BYTES = 1_000_000;

/** TTL for editor save markers (ms). Must exceed chokidar's awaitWriteFinish delay. */
const EDITOR_SAVE_TTL_MS = 2000;
const FILE_CHANGED_NOTIFY_DEDUPE_MS = 250;

/**
 * Per-session cap on remembered file stats. Only files actually read are
 * remembered, so a scan over thousands of untouched files cannot evict them.
 */
const MAX_SEEN_STATS = 4096;
/** Clock and filesystem timestamp granularity allowance around session start. */
const MTIME_START_SLACK_MS = 2000;
/**
 * A stat taken this soon after the mtime cannot prove "unchanged": a second
 * write inside the same timestamp tick with the same size looks identical.
 */
const RACY_MTIME_WINDOW_MS = 2000;

interface SeenStat {
  mtimeMs: number;
  size: number;
  /** When the session processed the file, to judge whether the stat can be trusted. */
  seenAt: number;
}

// ---------------------------------------------------------------------------
// Re-exports from WorkspaceEventBus for backward compatibility
// ---------------------------------------------------------------------------

/** Active session IDs currently attached to the shared watcher for a workspace. */
export function getSharedWatcherSessionIds(workspacePath: string): string[] {
  return workspaceEventBus.getSubscriberIds(workspacePath);
}

/** Visible for testing / diagnostics. */
export function getSharedWatcherCount(): number {
  return workspaceEventBus.getBusEntryCount();
}

/** Visible for testing. */
export function getSharedWatcherRefCount(workspacePath: string): number {
  return workspaceEventBus.getRefCount(workspacePath);
}

/** Reset shared watcher state. Only for tests. */
export function resetSharedWatchers(): void {
  workspaceEventBus.resetBus();
}

// ---------------------------------------------------------------------------
// SessionFileWatcher -- per-session wrapper that subscribes to WorkspaceEventBus
// ---------------------------------------------------------------------------

export interface SessionFileWatcherEditEvent {
  workspacePath: string;
  filePath: string;
  timestamp: number;
  beforeContent?: string | null;
}

export class SessionFileWatcher {
  private cache: FileSnapshotCache | null = null;
  private sessionId: string | null = null;
  private workspacePath: string | null = null;
  private active = false;
  private onFileChanged: ((event: SessionFileWatcherEditEvent) => Promise<void> | void) | null = null;
  private startedAt = 0;
  /**
   * What this session last saw of each file it read, oldest first. Per session
   * rather than shared: sessions fan out from the same event, so a shared record
   * updated by the first would make the others skip a change they never saw.
   */
  private seenStats = new Map<string, SeenStat>();

  /**
   * File paths recently saved by the Nimbalyst editor (user saves).
   * These are excluded from AI tool call matching so human edits
   * don't get attributed to AI tool calls.
   */
  private static recentEditorSaves = new Map<string, number>();
  private static recentDiskNotifications = new Map<string, number>();

  /**
   * Mark a file as recently saved by the editor.
   * Called from FileHandlers when the user saves a file (Cmd+S / autosave).
   */
  static markEditorSave(filePath: string, content?: string): void {
    markKnownFileWrite(filePath, content);
    SessionFileWatcher.recentEditorSaves.set(path.normalize(filePath), Date.now());
  }

  private isRecentEditorSave(filePath: string): boolean {
    const normalized = path.normalize(filePath);
    const savedAt = SessionFileWatcher.recentEditorSaves.get(normalized);
    if (savedAt === undefined) return false;
    if (Date.now() - savedAt > EDITOR_SAVE_TTL_MS) {
      SessionFileWatcher.recentEditorSaves.delete(normalized);
      return false;
    }
    return true;
  }

  async start(
    workspacePath: string,
    sessionId: string,
    cache: FileSnapshotCache,
    onFileChanged?: (event: SessionFileWatcherEditEvent) => Promise<void> | void
  ): Promise<void> {
    await this.stop();

    this.cache = cache;
    this.sessionId = sessionId;
    this.workspacePath = workspacePath;
    this.active = true;
    this.onFileChanged = onFileChanged ?? null;
    this.startedAt = Date.now();
    this.seenStats.clear();

    await workspaceEventBus.subscribe(workspacePath, sessionId, {
      onChange: (filePath: string) => this.handleChange(filePath),
      onAdd: (filePath: string) => this.handleAdd(filePath),
      onUnlink: (filePath: string) => this.handleUnlink(filePath),
    });

    // logger.main.info('[SessionFileWatcher] Started watching:', { workspacePath, sessionId });
  }

  async stop(): Promise<void> {
    if (this.workspacePath && this.sessionId) {
      workspaceEventBus.unsubscribe(this.workspacePath, this.sessionId);
    }
    this.cache = null;
    this.sessionId = null;
    this.workspacePath = null;
    this.active = false;
    this.onFileChanged = null;
    this.seenStats.clear();
  }

  isActive(): boolean {
    return this.active;
  }

  private isBinaryPath(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  /**
   * Current disk content, or null when the file is gone, too large, or binary.
   * The extension check misses extensionless binaries (browser profile caches,
   * SQLite journals); without the size cap and NUL sniff, every session read
   * and cached them in full on each write (#1599).
   *
   * The stat and the read go through the shared reader, so sessions reacting to
   * the same event share one operation and the process-wide fs limit applies.
   */
  private async readTextContent(filePath: string, stat: WatchedFileStat | null): Promise<string | null> {
    if (!stat || stat.size > MAX_SNAPSHOT_FILE_BYTES) return null;
    const result = await readWatchedText(filePath);
    // Binary content is a settled answer; a failed read is not, so it is retried.
    if (result.status === 'binary') this.rememberStat(filePath, stat);
    return result.status === 'text' ? result.content : null;
  }

  private rememberStat(filePath: string, stat: WatchedFileStat): void {
    this.seenStats.delete(filePath);
    this.seenStats.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, seenAt: Date.now() });
    if (this.seenStats.size > MAX_SEEN_STATS) {
      this.seenStats.delete(this.seenStats.keys().next().value!);
    }
  }

  /**
   * A change event does not mean the content changed: with last-access updates
   * on, a program that merely reads a file reports it too, and an indexer over
   * thousands of files reports thousands. Skip when nothing this session could
   * have written is different, judged from one stat and no read.
   *
   * Files this session already read are only skipped on an identical stat, so
   * an edit and its revert are both attributed even when the revert restores an
   * old mtime. Files it never read are skipped when last written before it
   * started; an in-session write always carries a newer mtime.
   */
  private canSkipChange(filePath: string, stat: WatchedFileStat): boolean {
    // Unknown timestamps cannot prove anything.
    if (!Number.isFinite(stat.mtimeMs)) return false;
    const seen = this.seenStats.get(filePath);
    if (!seen) return stat.mtimeMs < this.startedAt - MTIME_START_SLACK_MS;
    return seen.mtimeMs === stat.mtimeMs
      && seen.size === stat.size
      && seen.seenAt - stat.mtimeMs > RACY_MTIME_WINDOW_MS;
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!this.active || !this.cache || !this.sessionId || !this.workspacePath) return;
    if (this.isBinaryPath(filePath)) return;
    if (this.isRecentEditorSave(filePath)) return;
    if (!this.isPathInWorkspace(filePath, this.workspacePath)) return;

    try {
      logger.main.debug('[SessionFileWatcher] Change event received:', {
        sessionId: this.sessionId,
        filePath,
      });

      const stat = await statWatchedFile(filePath);
      if (!this.active || !this.cache) return;
      // Nothing this session could have written changed (e.g. an access-time-only event)
      if (stat && this.canSkipChange(filePath, stat)) return;

      // File may have been deleted between event and read, or be too large / binary to diff
      const currentContent = await this.readTextContent(filePath, stat);
      if (currentContent === null || !this.active || !this.cache) return;

      const beforeContent = await this.cache.getBeforeState(filePath);

      if (beforeContent !== null && beforeContent === currentContent) {
        logger.main.debug('[SessionFileWatcher] No-op skip (content unchanged):', {
          workspacePath: this.workspacePath,
          filePath,
          sessionId: this.sessionId,
          reason: 'no_content_change',
        });
        this.cache.updateSnapshot(filePath, currentContent);
        if (stat) this.rememberStat(filePath, stat);
        return;
      }

      const timestamp = Date.now();
      if (this.onFileChanged) {
        await this.onFileChanged({
          workspacePath: this.workspacePath,
          filePath,
          timestamp,
          beforeContent,
        });
      }

      this.notifyFileChanged(filePath);
      logger.main.debug('[SessionFileWatcher] Emitted change event:', {
        sessionId: this.sessionId,
        filePath,
        timestamp,
        hasBeforeContent: beforeContent !== null,
      });

      // Update cache with current content for subsequent edits
      this.cache.updateSnapshot(filePath, currentContent);
      if (stat) this.rememberStat(filePath, stat);
    } catch (error) {
      logger.main.error('[SessionFileWatcher] Error handling file change:', error);
    }
  }

  private async handleAdd(filePath: string): Promise<void> {
    if (!this.active || !this.cache || !this.sessionId || !this.workspacePath) return;
    if (this.isBinaryPath(filePath)) return;
    if (this.isRecentEditorSave(filePath)) return;
    if (!this.isPathInWorkspace(filePath, this.workspacePath)) return;

    try {
      // File may have been deleted already, or be too large / binary to diff.
      // No stat-based skip here: a file moved in keeps its old mtime but is new to the session.
      const stat = await statWatchedFile(filePath);
      if (!this.active || !this.cache) return;
      const currentContent = await this.readTextContent(filePath, stat);
      if (currentContent === null || !this.active || !this.cache) return;

      // Atomic writes (write-to-temp then rename) trigger 'rename' events on macOS,
      // which get classified as 'add'. If the cache already has content for this path,
      // this is an overwrite of an existing file, not a truly new file creation.
      const beforeContent = await this.cache.getBeforeState(filePath);

      logger.main.debug('[SessionFileWatcher] Add event received:', {
        sessionId: this.sessionId,
        filePath,
        hasExistingCache: beforeContent !== null,
      });

      // If we had cached content and it matches the new content, skip (no real change)
      if (beforeContent !== null && beforeContent === currentContent) {
        logger.main.debug('[SessionFileWatcher] No-op skip (add event, content unchanged):', {
          filePath,
          sessionId: this.sessionId,
        });
        this.cache.updateSnapshot(filePath, currentContent);
        if (stat) this.rememberStat(filePath, stat);
        return;
      }

      const timestamp = Date.now();
      if (this.onFileChanged) {
        await this.onFileChanged({
          workspacePath: this.workspacePath,
          filePath,
          timestamp,
          beforeContent: beforeContent ?? '',
        });
      }

      this.notifyFileChanged(filePath);
      logger.main.debug('[SessionFileWatcher] Emitted add event:', {
        sessionId: this.sessionId,
        filePath,
        timestamp,
      });

      // Update cache with current content AFTER firing the event
      this.cache.updateSnapshot(filePath, currentContent);
      if (stat) this.rememberStat(filePath, stat);
    } catch (error) {
      logger.main.error('[SessionFileWatcher] Error handling file add:', error);
    }
  }

  private handleUnlink(_filePath: string): void {
    // Intentionally do NOT remove from cache on unlink.
    // Atomic writes (write-to-temp, rename) trigger unlink+add in quick succession.
    // Removing the cache entry here would lose the "before" state needed by handleAdd
    // to produce a correct diff. The cache has a bounded memory cap and is cleaned up
    // when the session stops, so stale entries are not a concern.
  }

  private isPathInWorkspace(filePath: string, workspacePath: string): boolean {
    const resolvedFile = path.resolve(filePath);
    const resolvedWorkspace = path.resolve(workspacePath);
    return resolvedFile === resolvedWorkspace || resolvedFile.startsWith(resolvedWorkspace + path.sep);
  }

  private notifyFileChanged(filePath: string): void {
    const normalized = path.normalize(filePath);
    const now = Date.now();

    for (const [trackedPath, notifiedAt] of SessionFileWatcher.recentDiskNotifications.entries()) {
      if ((now - notifiedAt) > FILE_CHANGED_NOTIFY_DEDUPE_MS) {
        SessionFileWatcher.recentDiskNotifications.delete(trackedPath);
      }
    }

    const lastNotifiedAt = SessionFileWatcher.recentDiskNotifications.get(normalized);
    if (lastNotifiedAt != null && (now - lastNotifiedAt) < FILE_CHANGED_NOTIFY_DEDUPE_MS) {
      return;
    }
    SessionFileWatcher.recentDiskNotifications.set(normalized, now);

    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('file-changed-on-disk', { path: filePath });
      }
    }
  }
}
