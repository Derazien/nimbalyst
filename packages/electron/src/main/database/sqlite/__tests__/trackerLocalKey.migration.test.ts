/**
 * Migration test for 0033_tracker_local_key.
 *
 * The point of the column is the uniqueness guarantee, not the column itself.
 * Both previous attempts at local numbering were rolled back because the same
 * number reached two items, and a recycled number resolves to the wrong item
 * with no warning. The partial unique index is the backstop that makes that
 * impossible regardless of what the allocation code does, so it is what this
 * test pins. The PGLite equivalent lives in worker.js; both must stay in sync.
 */

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

async function insertItem(
  sqlite: SQLiteDatabase,
  params: { id: string; workspace: string; localKey: string | null },
): Promise<void> {
  await sqlite.query(
    `INSERT INTO tracker_items (id, type, data, workspace, local_key, created, updated)
     VALUES ($1, 'bug', '{"title":"t"}', $2, $3, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')`,
    [params.id, params.workspace, params.localKey],
  );
}

describe('0033_tracker_local_key migration (SQLite backend)', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-local-key-migrate-'));
    sqlite = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registers and applies migration version 33', async () => {
    const { rows } = await sqlite.query<{ version: number }>(
      `SELECT version FROM _migrations WHERE version = 33`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses the same local number twice within one project', async () => {
    await insertItem(sqlite, { id: 'a', workspace: '/src/app', localKey: 'NIM.12' });

    await expect(
      insertItem(sqlite, { id: 'b', workspace: '/src/app', localKey: 'NIM.12' }),
    ).rejects.toThrow();
  });

  it('allows the same local number in a different project', async () => {
    await insertItem(sqlite, { id: 'a', workspace: '/src/app', localKey: 'NIM.12' });
    await insertItem(sqlite, { id: 'b', workspace: '/src/site', localKey: 'NIM.12' });

    const { rows } = await sqlite.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM tracker_items WHERE local_key = 'NIM.12'`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('leaves unnumbered items alone rather than colliding on NULL', async () => {
    await insertItem(sqlite, { id: 'a', workspace: '/src/app', localKey: null });
    await insertItem(sqlite, { id: 'b', workspace: '/src/app', localKey: null });

    const { rows } = await sqlite.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM tracker_items WHERE local_key IS NULL`,
    );
    expect(rows[0].count).toBe(2);
  });
});
