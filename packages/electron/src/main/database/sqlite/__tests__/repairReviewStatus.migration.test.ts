/**
 * Migration test for 0038_repair_double_quoted_review_status (#1403).
 *
 * The rows this repairs were written by a real code path against a real SQLite
 * database, so the test seeds the exact corrupted shape rather than asserting
 * on the migration's text. Exercises the real SQLiteDatabase + migrationRunner
 * path, so a missing entry in getMigrations() fails here.
 */

// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

/** The corrupted value as it was actually stored: a JSON string containing quotes. */
const DOUBLE_QUOTED = '"reviewed"';

describe('0038_repair_double_quoted_review_status', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-repair-status-'));
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      log: () => {
        /* quiet */
      },
    });
    await sqlite.initialize();
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function insert(id: string, status: string, content: string): Promise<void> {
    await sqlite.query(
      `INSERT INTO document_history (workspace_id, file_path, timestamp, content, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      ['/ws', `/ws/${id}.ts`, 1000, content, JSON.stringify({ type: 'pre-edit', status })],
    );
  }

  it('is registered, so an existing install actually runs it', async () => {
    const { rows } = await sqlite.query<{ version: number }>(
      `SELECT version FROM _migrations WHERE version = 38`,
    );
    expect(rows).toEqual([{ version: 38 }]);
  });

  it('rewrites the double-quoted status and leaves the other rows and their baselines alone', async () => {
    await insert('corrupt', DOUBLE_QUOTED, 'baseline-bytes');
    await insert('pending', 'pending-review', 'still-pending');
    await insert('clean', 'reviewed', 'already-fine');

    // Migrations already ran at initialize(), so replay the real file against
    // the seeded corruption rather than a copy of its SQL. Replaying is also
    // the assertion that it is idempotent: the `clean` row was already
    // `reviewed` on the first pass and must not be touched a second time.
    const migrationSql = fs.readFileSync(
      path.join(SCHEMA_DIR, '0038_repair_double_quoted_review_status.sql'),
      'utf-8',
    );
    await sqlite.query(migrationSql);

    const { rows } = await sqlite.query<{ file_path: string; status: string; content: string }>(
      `SELECT file_path, metadata->>'status' AS status, CAST(content AS TEXT) AS content
       FROM document_history ORDER BY file_path`,
    );

    expect(rows).toEqual([
      { file_path: '/ws/clean.ts', status: 'reviewed', content: 'already-fine' },
      // Repaired: readable as reviewed, baseline bytes untouched.
      { file_path: '/ws/corrupt.ts', status: 'reviewed', content: 'baseline-bytes' },
      // A live pending tag must survive the repair.
      { file_path: '/ws/pending.ts', status: 'pending-review', content: 'still-pending' },
    ]);
  });
});
