// @vitest-environment node
/**
 * A project can span several folders, so "the files in this workspace" is no
 * longer "the files under one path prefix". Every pending-review query keyed on
 * `file_path LIKE workspacePath || '%'` silently skipped anything under an
 * attached folder: the review dots never appeared for those files, the pending
 * count under-reported, and "Clear all pending" left their rows pending
 * forever -- the same stale-badge failure #1403 set out to kill, reached
 * through a different door.
 *
 * These run against a REAL SQLite database rather than the fake-query harness
 * the sibling HistoryManager tests use. The change under test is the shape of
 * the SQL itself, and a regex-interpreting fake cannot tell a correct OR-of-
 * roots predicate from a broken one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// The roots list is the whole point of the change; drive it per test.
const roots = vi.fn<(workspacePath: string) => string[]>((w) => [w]);
vi.mock('../utils/store', () => ({
  getWorkspaceRoots: (workspacePath: string) => roots(workspacePath),
  getAppSetting: vi.fn(() => undefined),
}));

// Point the database singleton at a real SQLite instance.
const db = { current: null as any };
vi.mock('../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => db.current !== null,
    initialize: async () => {},
    // `md()` builds its WHERE predicates from this; getting it wrong picks the
    // dialect whose expression indexes never match.
    getEngine: () => 'sqlite',
    query: (sql: string, params?: unknown[]) => db.current.query(sql, params),
  },
}));

import { SQLiteDatabase } from '../database/sqlite/SQLiteDatabase';
import { HistoryManager } from '../HistoryManager';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'database', 'sqlite', 'schemas');

const PRIMARY = '/proj/primary';
const ATTACHED = '/elsewhere/attached-repo';
const SESSION = 'session-1';

describe('HistoryManager across multiple workspace roots', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;
  let history: HistoryManager;

  async function seedPending(filePath: string): Promise<void> {
    await sqlite.query(
      `INSERT INTO document_history (workspace_id, file_path, timestamp, content, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        // Deliberately the file's own directory, not the workspace root: real
        // rows carry that shape, which is why workspace_id cannot be the key.
        path.dirname(filePath),
        filePath,
        Date.now(),
        Buffer.from('baseline'),
        JSON.stringify({ type: 'pre-edit', status: 'pending-review', sessionId: SESSION }),
      ],
    );
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-history-multiroot-'));
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      log: () => {
        /* quiet */
      },
    });
    await sqlite.initialize();
    db.current = sqlite;

    roots.mockImplementation((w) => (w === PRIMARY ? [PRIMARY, ATTACHED] : [w]));
    history = new HistoryManager();

    await seedPending(`${PRIMARY}/src/a.ts`);
    await seedPending(`${ATTACHED}/src/b.ts`);
    // A third root the workspace does NOT span, to prove the predicate is
    // scoped rather than simply matching everything.
    await seedPending('/unrelated/c.ts');
  });

  afterEach(async () => {
    db.current = null;
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('counts pending files under an attached folder', async () => {
    expect(await history.getPendingCount(PRIMARY)).toBe(2);
  });

  it('lists a session pending file under an attached folder', async () => {
    const files = await history.getPendingFilesForSession(PRIMARY, SESSION);
    expect(files.sort()).toEqual([`${ATTACHED}/src/b.ts`, `${PRIMARY}/src/a.ts`]);
  });

  it('clears pending tags under an attached folder and leaves other roots alone', async () => {
    const { count, clearedFiles } = await history.clearAllPending(PRIMARY);
    expect(count).toBe(2);
    expect(clearedFiles.sort()).toEqual([`${ATTACHED}/src/b.ts`, `${PRIMARY}/src/a.ts`]);

    const { rows } = await sqlite.query<{ file_path: string }>(
      `SELECT file_path FROM document_history WHERE metadata->>'status' = 'pending-review'`,
    );
    expect(rows.map((r) => r.file_path)).toEqual(['/unrelated/c.ts']);
  });

  it('still scopes to a single path when the workspace has no attached folders', async () => {
    // GitWorktreeService clears by worktree root, which is never a workspace
    // key -- it must keep behaving as a plain prefix match.
    const { count, clearedFiles } = await history.clearAllPending(ATTACHED);
    expect(count).toBe(1);
    expect(clearedFiles).toEqual([`${ATTACHED}/src/b.ts`]);
  });
});
