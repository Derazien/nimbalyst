import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cross-workspace READ for list_recent_sessions.
//
// The estate had cross-workspace WRITE (send_prompt reaches another project once
// agent.crossWorkspaceMessaging is on) and no cross-workspace READ, so the only way to reach a
// session in another project was to already know its id. These guard the fix and, more
// importantly, that it did NOT invent a second permission rule: the same predicate that governs
// messaging governs listing, so a mode change moves both together.

const sessionsByWorkspace = new Map<string, unknown[]>();
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    list: vi.fn(async (workspaceId: string) => sessionsByWorkspace.get(workspaceId) ?? []),
    search: vi.fn(async (workspaceId: string) => sessionsByWorkspace.get(workspaceId) ?? []),
    getMany: vi.fn(async () => []),
  },
  SessionFilesRepository: { getFilesBySession: vi.fn(async () => []) },
}));
vi.mock('../../services/sessionSummaryPrompt', () => ({
  appendPendingPromptSection: (text: string) => text,
  collectPendingPromptDescriptionsFromRawRows: () => [],
}));
vi.mock('../../database/initialize', () => ({
  getDatabase: () => ({ query: async () => ({ rows: [] }) }),
}));

const settingsGet = vi.fn();
vi.mock('../../services/SettingsService', () => ({
  getSettingsService: () => ({ get: settingsGet }),
}));
const liveWindows = new Set<string>();
vi.mock('../../window/windowState', () => ({
  hasLiveWindowForWorkspace: (p: string) => liveWindows.has(p),
  listOpenWorkspacePaths: () => [...liveWindows],
}));

import { handleListRecentSessions } from '../sessionContextServer';

const HOME = '/ws/home';
const OTHER = '/ws/other';
const CALLER = 'meta-1';

const s = (id: string, title: string, workspacePath: string, createdBy: string | null = null) => ({
  id,
  title,
  workspacePath,
  createdBySessionId: createdBy,
  sessionType: 'chat',
  updatedAt: 100,
  createdAt: 1,
  parentSessionId: null,
});

async function list(scopes?: string[]): Promise<string> {
  return handleListRecentSessions(undefined, 10, 0, HOME, CALLER, false, 'both', scopes);
}

describe('list_recent_sessions across workspaces', () => {
  beforeEach(() => {
    settingsGet.mockReset();
    settingsGet.mockReturnValue('off');
    liveWindows.clear();
    sessionsByWorkspace.clear();
    sessionsByWorkspace.set(HOME, [s('h1', 'Home work', HOME)]);
    sessionsByWorkspace.set(OTHER, [s('o1', 'Other project thing', OTHER, 'someone-else')]);
  });

  it('lists only the caller workspace when nothing is asked for, exactly as before', async () => {
    const out = await list();
    expect(out).toContain('Home work');
    expect(out).not.toContain('Other project thing');
  });

  it('refuses another workspace while the setting is off, listing nothing from it', async () => {
    liveWindows.add(OTHER);
    const out = await list([OTHER]);
    expect(out).not.toContain('Other project thing');
  });

  it('lists another open workspace once the setting allows it', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    const out = await list([OTHER]);
    expect(out).toContain('Other project thing');
  });

  it('still refuses a workspace that is not open, even on allow', async () => {
    settingsGet.mockReturnValue('allow');
    // OTHER deliberately not added to liveWindows.
    const out = await list([OTHER]);
    expect(out).not.toContain('Other project thing');
  });

  it('on creator, shows only the sessions this caller created', async () => {
    settingsGet.mockReturnValue('creator');
    liveWindows.add(OTHER);
    sessionsByWorkspace.set(OTHER, [
      s('o1', 'Someone elses thing', OTHER, 'someone-else'),
      s('o2', 'My own child', OTHER, CALLER),
    ]);
    const out = await list([OTHER]);
    expect(out).toContain('My own child');
    expect(out).not.toContain('Someone elses thing');
  });

  it('never filters the caller own workspace, whatever the mode', async () => {
    settingsGet.mockReturnValue('off');
    const out = await list([HOME, OTHER]);
    expect(out).toContain('Home work');
    expect(out).not.toContain('Other project thing');
  });

  it('merges several workspaces newest first', async () => {
    settingsGet.mockReturnValue('allow');
    liveWindows.add(OTHER);
    sessionsByWorkspace.set(HOME, [{ ...s('h1', 'Older home', HOME), updatedAt: 50 }]);
    sessionsByWorkspace.set(OTHER, [{ ...s('o1', 'Newer other', OTHER, 'x'), updatedAt: 900 }]);
    const out = await list([HOME, OTHER]);
    expect(out.indexOf('Newer other')).toBeLessThan(out.indexOf('Older home'));
  });
});
