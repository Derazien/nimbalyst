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

import {
  isCrossWorkspaceAccessAllowed,
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
