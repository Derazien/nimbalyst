// @vitest-environment node
/**
 * Pins the plans for the hot `document_history` predicates against the real
 * schema DDL.
 *
 * All four partial indexes on this table are declared over
 * `json_extract(metadata,'$.key')`. SQLite does not treat `metadata->>'key'` as
 * the same expression, so a `->>` predicate quietly full-scans while returning
 * exactly the right rows — the pending-review lookup ran 732 times in five
 * minutes at ~76ms a call over 46,110 rows before this was found. The plan is
 * the only observable difference, so the plan is what this test asserts.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
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
import { jsonKeyExpr } from '../../jsonKeyExpr';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

let tmp: string;
let sqlite: SQLiteDatabase;

async function planFor(sql: string, params: unknown[] = []): Promise<string> {
  const result = await sqlite.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return result.rows.map((row) => row.detail).join(' | ');
}

const md = (key: string) => jsonKeyExpr('sqlite', 'metadata', key);
const arrow = (key: string) => `metadata->>'${key}'`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-history-plan-'));
  sqlite = new SQLiteDatabase({
    dbDir: path.join(tmp, 'sqlite-db'),
    schemaDir: SCHEMA_DIR,
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterAll(async () => {
  await sqlite.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('document_history expression indexes', () => {
  it('serves the pending-review lookup from idx_history_one_pending_per_file', async () => {
    const plan = await planFor(`
      SELECT file_path, content, metadata FROM document_history
      WHERE file_path = $1 AND ${md('status')} = 'pending-review'
    `, ['/tmp/a.md']);
    expect(plan).toContain('USING INDEX idx_history_one_pending_per_file');
  });

  it('serves the per-session pending lookup from idx_history_pending_session_file', async () => {
    const plan = await planFor(`
      SELECT DISTINCT file_path FROM document_history
      WHERE ${md('sessionId')} = $1
        AND ${md('status')} = 'pending-review'
        AND file_path LIKE $2
    `, ['sess-1', '/tmp/%']);
    expect(plan).toContain('USING INDEX idx_history_pending_session_file');
  });

  it('serves the pre-edit snapshot lookup from idx_history_preedit_session', async () => {
    const plan = await planFor(`
      SELECT file_path, content FROM document_history
      WHERE ${md('sessionId')} = $1 AND ${md('type')} = 'pre-edit'
    `, ['sess-1']);
    expect(plan).toContain('USING INDEX idx_history_preedit_session');
  });

  // The regression itself. If SQLite ever starts matching `->>` against a
  // json_extract index this flips, and the accessor split (and its gate) can go.
  it('full-scans when the same predicates use the `->>` accessor', async () => {
    const plan = await planFor(`
      SELECT DISTINCT file_path FROM document_history
      WHERE ${arrow('sessionId')} = $1
        AND ${arrow('status')} = 'pending-review'
        AND file_path LIKE $2
    `, ['sess-1', '/tmp/%']);
    // SCAN, never SEARCH: no predicate seeks. The planner may still pick a
    // narrow non-expression index (idx_history_file_timestamp) to scan instead
    // of the table, which is why this names the expression indexes rather than
    // asserting no index at all.
    expect(plan).toContain('SCAN document_history');
    expect(plan).not.toContain('SEARCH document_history');
    for (const expressionIndex of [
      'idx_history_pending_session_file',
      'idx_history_preedit_session',
      'idx_history_one_pending_per_file',
      'idx_history_file_content_hash',
    ]) {
      expect(plan).not.toContain(expressionIndex);
    }
  });
});
