// @vitest-environment node
/**
 * Opening a session from a chip, a tray entry or a tracker menu used to mean "open this id in
 * this window". For a session that lives in another project that showed its transcript under
 * the wrong project, absent from the sidebar. The decision is now one function with the host
 * calls injected, so it can be proven without a window.
 */
import { describe, expect, it, vi } from 'vitest';
import { openSessionById } from '../openSessionReference';

const deps = (over: Partial<Parameters<typeof openSessionById>[1]> = {}) => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      locate: vi.fn(async () => null as { workspacePath: string | null; foreign: boolean; title?: string | null } | null),
      openHere: vi.fn(async () => { calls.push('here'); }),
      openInProject: vi.fn(async () => { calls.push('project'); return { ok: true }; }),
      ...over,
    },
  };
};

describe('openSessionById', () => {
  it('opens a session of this project here, exactly as before', async () => {
    const { deps: d, calls } = deps({ locate: vi.fn(async () => ({ workspacePath: 'C:/work', foreign: false })) });
    expect(await openSessionById('s1', d)).toBe('here');
    expect(calls).toEqual(['here']);
    expect(d.openInProject).not.toHaveBeenCalled();
  });

  it('routes a session of another project to that project, and does not also open it here', async () => {
    const { deps: d, calls } = deps({
      locate: vi.fn(async () => ({ workspacePath: 'C:/work/artificial.inc', foreign: true, title: 'Smoke test' })),
    });
    expect(await openSessionById('s2', d)).toBe('routed');
    expect(calls).toEqual(['project']);
    expect(d.openInProject).toHaveBeenCalledWith({
      sessionId: 's2',
      workspacePath: 'C:/work/artificial.inc',
      sourceLabel: 'Smoke test',
    });
  });

  it('falls back to opening here when the host cannot say where the session lives', async () => {
    const { deps: d, calls } = deps({ locate: vi.fn(async () => { throw new Error('no such call'); }) });
    expect(await openSessionById('s3', d)).toBe('here');
    expect(calls).toEqual(['here']);
  });

  it('falls back to opening here when the other project refuses to open', async () => {
    const { deps: d, calls } = deps({
      locate: vi.fn(async () => ({ workspacePath: 'C:/work/closed', foreign: true })),
      openInProject: vi.fn(async () => { calls.push('project'); return { ok: false, error: 'not open' }; }),
    });
    expect(await openSessionById('s4', d)).toBe('here');
    expect(calls).toEqual(['project', 'here']);
  });

  it('ignores an empty id rather than opening whatever is selected', async () => {
    const { deps: d, calls } = deps();
    expect(await openSessionById('', d)).toBe('ignored');
    expect(calls).toEqual([]);
  });
});
