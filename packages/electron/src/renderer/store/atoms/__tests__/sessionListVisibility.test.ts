// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { shouldShowInRootList } from '../sessionListVisibility';

function session(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    title: id,
    provider: 'test',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...rest,
  };
}

const SHOW_NEITHER = { showArchived: false, showCompanion: false };

describe('shouldShowInRootList', () => {
  it('preserves the existing rules when no companion sessions are present', () => {
    const root = session({ id: 'root' });
    const archived = session({ id: 'archived', isArchived: true });
    const meta = session({ id: 'meta', agentRole: 'meta-agent', parentSessionId: 'root' });
    const blitz = session({ id: 'blitz', sessionType: 'blitz' });
    const blitzChild = session({ id: 'blitz-child', parentSessionId: 'blitz' });
    const workstreamChild = session({ id: 'ws-child', parentSessionId: 'root' });
    const registry = new Map(
      [root, archived, meta, blitz, blitzChild, workstreamChild].map(s => [s.id, s]),
    );

    expect(shouldShowInRootList(root, registry, SHOW_NEITHER)).toBe(true);
    expect(shouldShowInRootList(archived, registry, SHOW_NEITHER)).toBe(false);
    // Upstream v0.80 nests parented meta-agents in session trees, not the root list.
    expect(shouldShowInRootList(meta, registry, SHOW_NEITHER)).toBe(false);
    expect(shouldShowInRootList(blitzChild, registry, SHOW_NEITHER)).toBe(true);
    expect(shouldShowInRootList(workstreamChild, registry, SHOW_NEITHER)).toBe(false);
  });

  it('shows archived sessions when the archive toggle is on', () => {
    const archived = session({ id: 'archived', isArchived: true });
    const registry = new Map([[archived.id, archived]]);

    expect(shouldShowInRootList(archived, registry, {
      showArchived: true,
      showCompanion: false,
    })).toBe(true);
  });

  it('hides the companion head and her assistants by default', () => {
    const lea = session({ id: 'lea', agentRole: 'companion' });
    const reviewer = session({ id: 'reviewer', agentRole: 'sub-companion' });
    const registry = new Map([lea, reviewer].map(s => [s.id, s]));

    expect(shouldShowInRootList(lea, registry, SHOW_NEITHER)).toBe(false);
    expect(shouldShowInRootList(reviewer, registry, SHOW_NEITHER)).toBe(false);
  });

  it('shows them when the companion toggle is on', () => {
    const lea = session({ id: 'lea', agentRole: 'companion' });
    const reviewer = session({
      id: 'reviewer',
      agentRole: 'sub-companion',
      parentSessionId: 'lea',
    });
    const registry = new Map([lea, reviewer].map(s => [s.id, s]));
    const opts = { showArchived: false, showCompanion: true };

    expect(shouldShowInRootList(lea, registry, opts)).toBe(true);
    expect(shouldShowInRootList(reviewer, registry, opts)).toBe(true);
  });

  it('keeps hiding an archived companion session when only the companion toggle is on', () => {
    const reaped = session({
      id: 'reaped',
      agentRole: 'sub-companion',
      isArchived: true,
    });
    const registry = new Map([[reaped.id, reaped]]);

    expect(shouldShowInRootList(reaped, registry, {
      showArchived: false,
      showCompanion: true,
    })).toBe(false);
    expect(shouldShowInRootList(reaped, registry, {
      showArchived: true,
      showCompanion: true,
    })).toBe(true);
  });

  it('keeps work the companion spawned visible, because work is not an assistant', () => {
    const spawned = session({ id: 'watts', agentRole: 'standard', createdBySessionId: 'lea' });
    const registry = new Map([[spawned.id, spawned]]);

    expect(shouldShowInRootList(spawned, registry, SHOW_NEITHER)).toBe(true);
  });
});
