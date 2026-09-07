// @vitest-environment node

/**
 * The guard rail on destructive tracker schema changes (PRD principle 6 / D3).
 *
 * The counting rules run against a real SQLite item table because the two things
 * most likely to break them are backend-shaped: `data` arrives as JSON TEXT here
 * and as a parsed object on PGLite, and custom field values live in two storage
 * shapes (top-level and nested under `customFields`) that must both count.
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

const findTeamForWorkspace = vi.fn();
vi.mock('../../TeamService', () => ({
  findTeamForWorkspace: (...args: unknown[]) => findTeamForWorkspace(...args),
}));

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import {
  evaluateTrackerSchemaChange,
  resolveTrackerSchemaActorRole,
  TrackerSchemaChangeBlockedError,
  type TrackerItemCountDb,
} from '../trackerSchemaChangeGuard';
import type {
  FieldDefinition,
  TrackerDataModel,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/alpha';

const titleField: FieldDefinition = { name: 'title', type: 'string' };
const severityField: FieldDefinition = { name: 'severity', type: 'number' };
const statusField: FieldDefinition = {
  name: 'status',
  type: 'select',
  options: [
    { value: 'open', label: 'Open' },
    { value: 'blocked', label: 'Blocked' },
  ],
};

function model(fields: FieldDefinition[], extra?: Partial<TrackerDataModel>): TrackerDataModel {
  return {
    type: 'bug',
    displayName: 'Bug',
    displayNamePlural: 'Bugs',
    fields,
    roles: { workflowStatus: 'status' },
    ...extra,
  } as unknown as TrackerDataModel;
}

describe('trackerSchemaChangeGuard', () => {
  let tmp: string;
  let db: SQLiteDatabase;
  let queries: string[];
  let countingDb: TrackerItemCountDb;

  beforeEach(async () => {
    findTeamForWorkspace.mockReset();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-schema-guard-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    queries = [];
    countingDb = {
      query: (sql: string, params?: unknown[]) => {
        queries.push(sql);
        return db.query(sql, params as any[]) as Promise<unknown>;
      },
      getEngine: () => 'sqlite',
    };
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function seedItem(id: string, data: Record<string, unknown>): Promise<void> {
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace) VALUES ($1, 'bug', $2, $3)`,
      [id, JSON.stringify(data), WS],
    );
  }

  /** 7 items carry `severity`; 3 of those sit in `blocked`. */
  async function seedBlastRadiusFixture(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await seedItem(`sev-open-${i}`, { title: `t${i}`, severity: i + 1, status: 'open' });
    }
    for (let i = 0; i < 3; i++) {
      // Nested shape: how synced / CLI-written items store their custom fields.
      await seedItem(`sev-blocked-${i}`, {
        title: `b${i}`,
        status: 'blocked',
        customFields: { severity: 9 },
      });
    }
    await seedItem('no-severity', { title: 'untouched', status: 'open' });
  }

  it('counts an item that carries the type only as a tag', async () => {
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace, type_tags)
       VALUES ('tagged', 'plan', $1, $2, '["bug"]')`,
      [JSON.stringify({ title: 'a plan that is also a bug', severity: 4 }), WS],
    );

    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, severityField]),
      next: model([titleField]),
      confirmed: false,
      actorRole: 'admin',
      dbOverride: countingDb,
    });

    expect(decision.blastRadiusText).toBe('1 item has `severity`.');
  });

  it('applies an additive change without confirmation and without reading the item table', async () => {
    await seedBlastRadiusFixture();

    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, statusField]),
      next: model([titleField, statusField, severityField]),
      confirmed: false,
      actorRole: 'member',
      dbOverride: countingDb,
    });

    expect(decision.verdict).toEqual({ allowed: true, reason: 'additive' });
    // The additive path is the common case; pricing it would be pure cost.
    expect(queries).toEqual([]);
  });

  it('counts the blast radius across both custom-field storage shapes', async () => {
    await seedBlastRadiusFixture();

    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, statusField, severityField]),
      next: model([titleField, { ...statusField, options: [{ value: 'open', label: 'Open' }] }]),
      confirmed: false,
      actorRole: 'admin',
      dbOverride: countingDb,
    });

    expect(decision.blastRadiusText).toBe('7 items have `severity`; 3 are in `blocked`.');
    // One query for the whole blast radius, not one per destructive change.
    expect(queries).toHaveLength(1);
  });

  it('does not count another workspace or a deleted item', async () => {
    await seedItem('mine', { title: 'a', severity: 1 });
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace) VALUES ('theirs', 'bug', $1, '/ws/beta')`,
      [JSON.stringify({ title: 'b', severity: 2 })],
    );
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace, deleted_at)
       VALUES ('gone', 'bug', $1, $2, '2026-01-01T00:00:00.000Z')`,
      [JSON.stringify({ title: 'c', severity: 3 }), WS],
    );

    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, severityField]),
      next: model([titleField]),
      confirmed: false,
      actorRole: 'admin',
      dbOverride: countingDb,
    });

    expect(decision.blastRadiusText).toBe('1 item has `severity`.');
  });

  it('refuses a member a destructive change to a team tracker, and offers the additive route', async () => {
    await seedBlastRadiusFixture();
    const sharedTeam = { sharing: 'team' } as Partial<TrackerDataModel>;

    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, statusField, severityField], sharedTeam),
      next: model([titleField, statusField], sharedTeam),
      confirmed: true,
      actorRole: 'member',
      dbOverride: countingDb,
    });

    expect(decision.verdict).toMatchObject({ allowed: false, reason: 'requires-admin' });
    const error = new TrackerSchemaChangeBlockedError('bug', decision);
    expect(error.reason).toBe('requires-admin');
    expect(error.message).toContain('7 items have `severity`');
    expect(error.message).toContain('only a team admin');
    expect(error.message).toContain('Adding fields, statuses and options is unrestricted');
  });

  it('judges a personal-to-team save by the stricter team rule', async () => {
    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, severityField], { sharing: 'personal' } as Partial<TrackerDataModel>),
      next: model([titleField], { sharing: 'team' } as Partial<TrackerDataModel>),
      confirmed: true,
      actorRole: 'member',
      dbOverride: countingDb,
    });

    expect(decision.sharing).toBe('team');
    expect(decision.verdict).toMatchObject({ allowed: false, reason: 'requires-admin' });
  });

  it('tells an unconfirmed caller what to do next, with rename offered first', async () => {
    await seedBlastRadiusFixture();
    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: model([titleField, statusField, severityField]),
      next: model([titleField, statusField, { name: 'priority', type: 'number' }]),
      confirmed: false,
      actorRole: 'admin',
      dbOverride: countingDb,
    });

    expect(decision.verdict).toMatchObject({ allowed: false, reason: 'needs-confirmation' });
    expect(decision.copy?.options[0]).toMatchObject({
      kind: 'rename',
      rename: { previousFieldName: 'severity', nextFieldName: 'priority' },
    });
    const error = new TrackerSchemaChangeBlockedError('bug', decision);
    expect(error.message).toContain('confirmDestructive: true');
    expect(error.message).toContain('Rename `severity` → `priority` (keeps values)');
  });

  it('treats a brand-new type as additive rather than diffing it against nothing', async () => {
    const decision = await evaluateTrackerSchemaChange({
      workspacePath: WS,
      previous: undefined,
      next: model([titleField, statusField]),
      confirmed: false,
      actorRole: 'member',
      dbOverride: countingDb,
    });

    expect(decision.verdict).toEqual({ allowed: true, reason: 'additive' });
  });

  describe('resolveTrackerSchemaActorRole', () => {
    it.each([
      { role: 'admin', expected: 'admin' },
      { role: 'owner', expected: 'admin' },
      { role: 'member', expected: 'member' },
    ])('maps team role $role to $expected', async ({ role, expected }) => {
      findTeamForWorkspace.mockResolvedValue({ orgId: 'o1', role });
      await expect(resolveTrackerSchemaActorRole(WS)).resolves.toBe(expected);
    });

    // No team means no team tracker, so there is nobody to be an admin over.
    // Failing closed here would lock a solo user out of their own schemas.
    it('treats a workspace with no team as admin', async () => {
      findTeamForWorkspace.mockResolvedValue(null);
      await expect(resolveTrackerSchemaActorRole(WS)).resolves.toBe('admin');
    });
  });
});
