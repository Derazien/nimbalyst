// @vitest-environment node
/**
 * Sharing a tracker moves where it lives in the sidebar. A tracker that was
 * organized into one of your personal folders can't stay there once it is the
 * team's -- peers have no such folder -- so its placement lands at the root of
 * the team section, and the row re-enters the push lane it was gated out of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dbRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../database/initialize', () => ({ getDatabase: () => dbRef.current }));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  applyTrackerSharingChangeToNavigation,
  saveWorkspaceTrackerNavigationEntry,
} from '../TrackerNavigationService';
import {
  listTrackerNavigationEntries,
  listUnsyncedTrackerNavigationEntries,
} from '../tracker/trackerNavigationStore';
import { materializeTrackerTypeDef } from '../tracker/trackerTypeDefStore';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/navigation-service';

const typeModel = (type: string, sharing: 'personal' | 'team'): TrackerDataModel =>
  ({ type, displayName: type, fields: [], roles: {}, sharing } as unknown as TrackerDataModel);

describe('applyTrackerSharingChangeToNavigation', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-navigation-service-'));
    dbRef.current = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await dbRef.current.initialize();
  });

  afterEach(async () => {
    await dbRef.current.close();
    dbRef.current = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('moves a shared tracker out of a personal folder and back into the push lane', async () => {
    await materializeTrackerTypeDef(WS, typeModel('bug', 'personal'), 'yaml', dbRef.current);
    await saveWorkspaceTrackerNavigationEntry(WS, {
      entryId: 'folder:mine', kind: 'folder', folderId: 'mine', name: 'Mine', sortKey: 'a0', ownership: 'personal',
    });
    await saveWorkspaceTrackerNavigationEntry(WS, {
      entryId: 'type:bug', kind: 'type-placement', trackerType: 'bug', folderId: 'mine', sortKey: 'a0',
    });
    expect(await listUnsyncedTrackerNavigationEntries(WS)).toEqual([]);

    await materializeTrackerTypeDef(WS, typeModel('bug', 'team'), 'yaml', dbRef.current);
    await applyTrackerSharingChangeToNavigation(WS, 'bug', 'team');

    const entries = await listTrackerNavigationEntries(WS);
    expect(entries.find((entry) => entry.entryId === 'type:bug')).toMatchObject({ folderId: null });
    // The folder itself is untouched -- no mirror folder is minted for the team.
    expect(entries.find((entry) => entry.entryId === 'folder:mine')).toMatchObject({ ownership: 'personal' });
    expect((await listUnsyncedTrackerNavigationEntries(WS)).map((entry) => entry.entryId)).toEqual(['type:bug']);
  });

  it('leaves a tracker in place when its folder already matches, and still queues the push', async () => {
    await materializeTrackerTypeDef(WS, typeModel('bug', 'personal'), 'yaml', dbRef.current);
    await saveWorkspaceTrackerNavigationEntry(WS, {
      entryId: 'folder:ours', kind: 'folder', folderId: 'ours', name: 'Ours', sortKey: 'a0', ownership: 'team',
    });
    await saveWorkspaceTrackerNavigationEntry(WS, {
      entryId: 'type:bug', kind: 'type-placement', trackerType: 'bug', folderId: 'ours', sortKey: 'a0',
    });

    await materializeTrackerTypeDef(WS, typeModel('bug', 'team'), 'yaml', dbRef.current);
    await applyTrackerSharingChangeToNavigation(WS, 'bug', 'team');

    const entries = await listTrackerNavigationEntries(WS);
    expect(entries.find((entry) => entry.entryId === 'type:bug')).toMatchObject({ folderId: 'ours' });
    expect((await listUnsyncedTrackerNavigationEntries(WS)).map((entry) => entry.entryId).sort())
      .toEqual(['folder:ours', 'type:bug']);
  });
});
