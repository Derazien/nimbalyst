// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// The runtime readers bind to SettingsService and the window registry; the
// predicate under test is pure, so both are stubbed to keep electron-store out
// of the graph.
const settingsGet = vi.fn();
vi.mock('../SettingsService', () => ({
  getSettingsService: () => ({ get: settingsGet }),
}));
const hasLiveWindowForWorkspace = vi.fn();
vi.mock('../../window/windowState', () => ({
  hasLiveWindowForWorkspace: (path: string) => hasLiveWindowForWorkspace(path),
}));

const alphaFeatures = vi.fn();
vi.mock('../../utils/store', () => ({
  getAlphaFeatures: () => alphaFeatures(),
}));

import {
  isCrossWorkspaceAccessAllowed,
  isCrossProjectSpawnAllowed,
  resolveCrossProjectSpawn,
  crossProjectSpawnRefusal,
  resolveCrossWorkspaceAccess,
  sessionNotReachableMessage,
  type CrossWorkspaceMessagingMode,
} from '../crossWorkspaceMessaging';

const CALLER = 'meta-1';
const HOME = '/ws/home';
const OTHER = '/ws/other';

function decide(
  mode: CrossWorkspaceMessagingMode,
  target: { workspacePath?: string | null; createdBySessionId?: string | null },
  loaded: string[] = [],
): boolean {
  return isCrossWorkspaceAccessAllowed({
    mode,
    callerSessionId: CALLER,
    callerWorkspaceId: HOME,
    target,
    isWorkspaceLoaded: (path) => loaded.includes(path),
  });
}

describe('isCrossWorkspaceAccessAllowed', () => {
  it('always allows the caller workspace, whatever the mode', () => {
    for (const mode of ['off', 'creator', 'allow'] as const) {
      expect(decide(mode, { workspacePath: HOME })).toBe(true);
    }
  });

  it('off blocks every other workspace, even the caller own child in a loaded window', () => {
    expect(decide('off', { workspacePath: OTHER, createdBySessionId: CALLER }, [OTHER])).toBe(false);
  });

  it('creator allows only sessions the caller created', () => {
    expect(decide('creator', { workspacePath: OTHER, createdBySessionId: CALLER })).toBe(true);
    expect(decide('creator', { workspacePath: OTHER, createdBySessionId: 'someone-else' }, [OTHER])).toBe(false);
    expect(decide('creator', { workspacePath: OTHER, createdBySessionId: null }, [OTHER])).toBe(false);
  });

  it('allow permits sessions in a loaded workspace and still blocks unloaded ones', () => {
    expect(decide('allow', { workspacePath: OTHER }, [OTHER])).toBe(true);
    expect(decide('allow', { workspacePath: OTHER }, [])).toBe(false);
  });

  it('allow is a superset of creator: the caller own child stays reachable when its window is closed', () => {
    expect(decide('allow', { workspacePath: OTHER, createdBySessionId: CALLER }, [])).toBe(true);
  });

  it('never grants access to a session with no workspace, and an empty caller id cannot claim creator', () => {
    expect(decide('allow', { workspacePath: null, createdBySessionId: CALLER }, [])).toBe(false);
    expect(
      isCrossWorkspaceAccessAllowed({
        mode: 'creator',
        callerSessionId: '',
        callerWorkspaceId: HOME,
        target: { workspacePath: OTHER, createdBySessionId: '' },
        isWorkspaceLoaded: () => true,
      }),
    ).toBe(false);
  });
});

describe('resolveCrossWorkspaceAccess (runtime binding)', () => {
  it('does not read the setting for same-workspace targets', () => {
    settingsGet.mockClear();
    const result = resolveCrossWorkspaceAccess(CALLER, HOME, { workspacePath: HOME });
    expect(result.allowed).toBe(true);
    expect(settingsGet).not.toHaveBeenCalled();
  });

  it('reads the setting and the window registry for other workspaces', () => {
    settingsGet.mockReturnValue('allow');
    hasLiveWindowForWorkspace.mockImplementation((path: string) => path === OTHER);
    expect(resolveCrossWorkspaceAccess(CALLER, HOME, { workspacePath: OTHER })).toEqual({ allowed: true, mode: 'allow' });
    expect(resolveCrossWorkspaceAccess(CALLER, HOME, { workspacePath: '/ws/closed' })).toEqual({ allowed: false, mode: 'allow' });
  });

  it('fails closed when the setting cannot be read, and refuses a missing session', () => {
    settingsGet.mockImplementation(() => { throw new Error('store unavailable'); });
    hasLiveWindowForWorkspace.mockReturnValue(true);
    expect(resolveCrossWorkspaceAccess(CALLER, HOME, { workspacePath: OTHER })).toEqual({ allowed: false, mode: 'off' });
    expect(resolveCrossWorkspaceAccess(CALLER, HOME, null).allowed).toBe(false);
  });

  it('names the setting in the refusal so a caller knows why', () => {
    expect(sessionNotReachableMessage('abc', 'off')).toBe(
      'Session abc not found or not allowed across workspaces (crossWorkspaceMessaging=off)',
    );
  });
});

/**
 * Spawning INTO another project is a different act from reaching a session that already
 * exists there: there is no target session, so `created_by` cannot be consulted. The rule is
 * the experimental toggle, a mode that is not off, and a project that is actually open.
 */
describe('isCrossProjectSpawnAllowed', () => {
  const spawn = (over: Partial<Parameters<typeof isCrossProjectSpawnAllowed>[0]> = {}) =>
    isCrossProjectSpawnAllowed({
      featureEnabled: true,
      mode: 'allow',
      callerWorkspaceId: HOME,
      targetWorkspacePath: OTHER,
      isWorkspaceLoaded: (path) => path === OTHER,
      ...over,
    });

  it('allows the caller own project without consulting the toggle or the mode', () => {
    expect(spawn({ targetWorkspacePath: HOME, featureEnabled: false, mode: 'off' })).toBe(true);
  });

  it('refuses another project while the experimental toggle is off', () => {
    expect(spawn({ featureEnabled: false })).toBe(false);
  });

  it('refuses another project while cross-workspace messaging is off', () => {
    expect(spawn({ mode: 'off' })).toBe(false);
  });

  it('allows another project under creator, because the caller owns what it creates', () => {
    expect(spawn({ mode: 'creator' })).toBe(true);
  });

  it('refuses a project that is not open, since nothing would run the session', () => {
    expect(spawn({ isWorkspaceLoaded: () => false })).toBe(false);
  });

  it('refuses an empty target rather than silently spawning at home', () => {
    expect(spawn({ targetWorkspacePath: '' })).toBe(false);
  });
});

describe('resolveCrossProjectSpawn (runtime binding)', () => {
  it('does not read settings for the caller own project', () => {
    settingsGet.mockClear();
    alphaFeatures.mockClear();
    expect(resolveCrossProjectSpawn(HOME, HOME).allowed).toBe(true);
    expect(settingsGet).not.toHaveBeenCalled();
    expect(alphaFeatures).not.toHaveBeenCalled();
  });

  it('reads the toggle, the mode and the window registry for another project', () => {
    alphaFeatures.mockReturnValue({ 'cross-project': true });
    settingsGet.mockReturnValue('allow');
    hasLiveWindowForWorkspace.mockImplementation((path: string) => path === OTHER);
    expect(resolveCrossProjectSpawn(HOME, OTHER)).toMatchObject({ allowed: true, mode: 'allow', featureEnabled: true });
    expect(resolveCrossProjectSpawn(HOME, '/ws/closed').allowed).toBe(false);
  });

  it('fails closed when the toggle cannot be read', () => {
    alphaFeatures.mockImplementation(() => { throw new Error('store unavailable'); });
    settingsGet.mockReturnValue('allow');
    hasLiveWindowForWorkspace.mockReturnValue(true);
    expect(resolveCrossProjectSpawn(HOME, OTHER).allowed).toBe(false);
  });

  it('says which of the two switches is the one to change', () => {
    expect(crossProjectSpawnRefusal(OTHER, { allowed: false, mode: 'allow', featureEnabled: false }))
      .toMatch(/Cross-project/);
    expect(crossProjectSpawnRefusal(OTHER, { allowed: false, mode: 'off', featureEnabled: true }))
      .toMatch(/crossWorkspaceMessaging=off/);
    expect(crossProjectSpawnRefusal(OTHER, { allowed: false, mode: 'allow', featureEnabled: true }))
      .toMatch(/not open/);
  });
});
