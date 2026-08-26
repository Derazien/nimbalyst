// @vitest-environment node
/**
 * Opening a session by project and id: the archived case.
 *
 * The navigator was written for desktop-notification clicks and refuses an archived session
 * with a warning. Chips, the tray and extension panels reuse it now, and from those an
 * archived session must open the way the sidebar opens one: the archive filter comes on, the
 * row is selected, the session stays archived. Notifications keep the warning.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared with the hoisted mock factories, so it must be hoisted too.
const { WS } = vi.hoisted(() => ({ WS: 'C:/work/artificial.inc' }));
const h = vi.hoisted(() => ({
  selected: [] as string[],
  refreshes: [] as Array<boolean | undefined>,
  listed: [] as Array<{ id: string; isArchived?: boolean }>,
  showWarning: vi.fn(() => 'n1'),
}));

vi.mock('@nimbalyst/runtime/store', async () => {
  const { createStore } = await import('jotai');
  return { store: createStore() };
});
vi.mock('../../atoms/sessions', async () => {
  const { atom } = await import('jotai');
  const sessionRegistryAtom = atom(new Map<string, { id: string; isArchived?: boolean }>());
  const showArchivedSessionsAtom = atom(false);
  const refreshSessionListAtom = atom(null, (_get, set, includeArchived?: boolean) => {
    h.refreshes.push(includeArchived);
    const next = new Map<string, { id: string; isArchived?: boolean }>();
    for (const s of h.listed) {
      if (s.isArchived && !includeArchived) continue;
      next.set(s.id, s);
    }
    set(sessionRegistryAtom, next);
  });
  return { sessionRegistryAtom, showArchivedSessionsAtom, refreshSessionListAtom, initSessionList: vi.fn(async () => {}) };
});
vi.mock('../../atoms/openProjects', async () => {
  const { atom } = await import('jotai');
  return {
    activeWorkspacePathAtom: atom<string | null>(WS),
    openProjectsAtom: atom([{ path: WS, name: 'artificial.inc', openedAt: 1 }]),
    addOpenProjectAtom: atom(null, () => {}),
  };
});
vi.mock('../../atoms/workstreamState', async () => {
  const { atom } = await import('jotai');
  return { initWorkstreamState: vi.fn(), loadWorkstreamStates: vi.fn(async () => {}), workstreamStatesLoadedAtom: atom(true) };
});
vi.mock('../../atoms/windowMode', async () => {
  const { atom } = await import('jotai');
  return { setWindowModeAtom: atom(null, () => {}) };
});
vi.mock('../sessionHistoryActions', async () => {
  const { atom } = await import('jotai');
  return { selectSessionActionAtom: atom(null, (_get, _set, id: string) => { h.selected.push(id); }) };
});
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showWarning: h.showWarning, dismiss: vi.fn() },
}));

import { store } from '@nimbalyst/runtime/store';
import { sessionRegistryAtom, showArchivedSessionsAtom } from '../../atoms/sessions';
import { navigateToNotificationSession } from '../sessionNotificationNavigation';

beforeEach(() => {
  h.selected.length = 0;
  h.refreshes.length = 0;
  h.showWarning.mockClear();
  store.set(sessionRegistryAtom, new Map());
  store.set(showArchivedSessionsAtom, false);
  h.listed = [{ id: 'live-1' }, { id: 'old-1', isArchived: true }];
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'sessions:list') return { success: true, sessions: h.listed };
        return { success: true };
      }),
    },
  };
});

describe('navigateToNotificationSession and archived sessions', () => {
  it('still warns and does not open an archived session for a notification click', async () => {
    const ok = await navigateToNotificationSession({ sessionId: 'old-1', workspacePath: WS, sourceLabel: 'Agent' });
    expect(ok).toBe(false);
    expect(h.showWarning).toHaveBeenCalled();
    expect(h.selected).toEqual([]);
  });

  it('opens an archived session when the caller allows it, the way the sidebar does', async () => {
    const ok = await navigateToNotificationSession({
      sessionId: 'old-1',
      workspacePath: WS,
      sourceLabel: 'Chip',
      allowArchived: true,
    });
    expect(ok).toBe(true);
    expect(h.showWarning).not.toHaveBeenCalled();
    // The archive filter comes on so the row is on screen, and the list is refreshed with
    // archived rows included so the selection has something to land on.
    expect(store.get(showArchivedSessionsAtom)).toBe(true);
    expect(h.refreshes).toContain(true);
    expect(h.selected).toEqual(['old-1']);
  });

  it('opens a live session without touching the archive filter', async () => {
    const ok = await navigateToNotificationSession({
      sessionId: 'live-1',
      workspacePath: WS,
      sourceLabel: 'Chip',
      allowArchived: true,
    });
    expect(ok).toBe(true);
    expect(store.get(showArchivedSessionsAtom)).toBe(false);
    expect(h.selected).toEqual(['live-1']);
  });
});
