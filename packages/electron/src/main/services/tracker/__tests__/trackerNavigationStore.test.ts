import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import {
  applyRemoteTrackerNavigationEntry,
  getMaxTrackerNavigationSyncId,
  listTrackerNavigationEntries,
  listUnsyncedTrackerNavigationEntries,
  removeTrackerNavigationEntry,
  upsertTrackerNavigationEntry,
} from '../trackerNavigationStore';
import { materializeTrackerTypeDef } from '../trackerTypeDefStore';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/navigation';

const typeModel = (type: string, sharing: 'personal' | 'team'): TrackerDataModel =>
  ({ type, displayName: type, fields: [], roles: {}, sharing } as unknown as TrackerDataModel);

describe('trackerNavigationStore', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-navigation-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists folders and placements in a workspace-scoped pending outbox', async () => {
    await materializeTrackerTypeDef(WS, typeModel('task', 'team'), 'yaml', db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0', ownership: 'team',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:task', kind: 'type-placement', trackerType: 'task', folderId: 'delivery', sortKey: 'a0',
    }, db);
    await upsertTrackerNavigationEntry('/ws/other', {
      entryId: 'folder:other', kind: 'folder', folderId: 'other', name: 'Other', sortKey: 'a0', ownership: 'team',
    }, db);

    expect((await listTrackerNavigationEntries(WS, db)).map((entry) => entry.entryId).sort()).toEqual([
      'folder:delivery', 'type:task',
    ]);
    const pending = await listUnsyncedTrackerNavigationEntries(WS, db);
    expect(pending).toHaveLength(2);
    expect(pending.every((entry) => entry.deleted === false && entry.payload !== null)).toBe(true);
  });

  it('keeps a personal folder and a personal tracker\'s placement out of the push outbox', async () => {
    await materializeTrackerTypeDef(WS, typeModel('reading', 'personal'), 'yaml', db);
    await materializeTrackerTypeDef(WS, typeModel('bug', 'team'), 'yaml', db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:mine', kind: 'folder', folderId: 'mine', name: 'Mine', sortKey: 'a0', ownership: 'personal',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:ours', kind: 'folder', folderId: 'ours', name: 'Ours', sortKey: 'a1', ownership: 'team',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:reading', kind: 'type-placement', trackerType: 'reading', folderId: 'mine', sortKey: 'a0',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:untouched', kind: 'type-placement', trackerType: 'untouched', folderId: null, sortKey: 'a2',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:bug', kind: 'type-placement', trackerType: 'bug', folderId: 'ours', sortKey: 'a1',
    }, db);

    // Everything still renders locally; only the push lane is narrowed.
    expect((await listTrackerNavigationEntries(WS, db)).map((entry) => entry.entryId).sort()).toEqual([
      'folder:mine', 'folder:ours', 'type:bug', 'type:reading', 'type:untouched',
    ]);
    expect((await listUnsyncedTrackerNavigationEntries(WS, db)).map((entry) => entry.entryId).sort())
      .toEqual(['folder:ours', 'type:bug']);

    // Deleting a personal folder must not push a tombstone for a row peers never saw.
    await removeTrackerNavigationEntry(WS, 'folder:mine', db);
    expect((await listUnsyncedTrackerNavigationEntries(WS, db)).map((entry) => entry.entryId).sort())
      .toEqual(['folder:ours', 'type:bug']);
  });

  it('refuses a remote placement for a tracker that is personal here', async () => {
    await materializeTrackerTypeDef(WS, typeModel('reading', 'personal'), 'yaml', db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:reading', kind: 'type-placement', trackerType: 'reading', folderId: null, sortKey: 'z0',
    }, db);

    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'type:reading',
      payload: JSON.stringify({
        entryId: 'type:reading', kind: 'type-placement', trackerType: 'reading', folderId: null, sortKey: 'a0',
      }),
      syncId: 9,
    }, db)).toEqual({ applied: false, reason: 'stale' });
    expect((await listTrackerNavigationEntries(WS, db))[0]).toMatchObject({ sortKey: 'z0' });
  });

  it('retracts a personal tracker placement that an older build already synced', async () => {
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'type:reading',
      payload: JSON.stringify({
        entryId: 'type:reading', kind: 'type-placement', trackerType: 'reading', folderId: null, sortKey: 'a0',
      }),
      syncId: 4,
    }, db)).toMatchObject({ applied: true, deleted: false });
    // Releases before ownership provenance did not distinguish a row learned
    // from a peer from one this client pushed and received back as an ack.
    await db.query(
      `UPDATE tracker_type_navigation SET sync_status = 'synced'
       WHERE workspace = $1 AND entry_id = $2`,
      [WS, 'type:reading'],
    );
    await materializeTrackerTypeDef(WS, typeModel('reading', 'personal'), 'yaml', db);

    expect(await listUnsyncedTrackerNavigationEntries(WS, db)).toEqual([
      { entryId: 'type:reading', payload: null, deleted: true },
    ]);

    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'type:reading', payload: null, syncId: 5,
    }, db)).toMatchObject({ applied: true, deleted: false });
    expect(await listTrackerNavigationEntries(WS, db)).toEqual([
      expect.objectContaining({ entryId: 'type:reading', sortKey: 'a0' }),
    ]);
    expect(await listUnsyncedTrackerNavigationEntries(WS, db)).toEqual([]);
  });

  it('does not retract a remote placement while its team schema is unavailable', async () => {
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'type:feature',
      payload: JSON.stringify({
        entryId: 'type:feature', kind: 'type-placement', trackerType: 'feature', folderId: null, sortKey: 'a0',
      }),
      syncId: 7,
    }, db)).toMatchObject({ applied: true, deleted: false });

    // Schema bootstrap can time out and deliberately continue into navigation
    // bootstrap. Missing schema means quarantine, not delete somebody else's
    // team placement from the room.
    expect(await listUnsyncedTrackerNavigationEntries(WS, db)).toEqual([]);
  });

  it('applies newer remote versions, ignores stale versions, and retains tombstones', async () => {
    const folder = JSON.stringify({
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0',
    });
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: folder, syncId: 5,
    }, db)).toMatchObject({ applied: true, deleted: false });
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: folder.replace('Delivery', 'Old'), syncId: 3,
    }, db)).toEqual({ applied: false, reason: 'stale' });
    expect(await getMaxTrackerNavigationSyncId(WS, db)).toBe(5);

    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: null, syncId: 6,
    }, db)).toMatchObject({ applied: true, deleted: true });
    expect(await listTrackerNavigationEntries(WS, db)).toEqual([]);
    expect(await getMaxTrackerNavigationSyncId(WS, db)).toBe(6);
  });

  it('soft-deletes local entries without losing the outbox tombstone', async () => {
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0', ownership: 'team',
    }, db);
    await removeTrackerNavigationEntry(WS, 'folder:delivery', db);
    expect(await listTrackerNavigationEntries(WS, db)).toEqual([]);
    expect(await listUnsyncedTrackerNavigationEntries(WS, db)).toEqual([
      { entryId: 'folder:delivery', payload: null, deleted: true },
    ]);
  });
});
