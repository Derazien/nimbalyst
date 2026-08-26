// @vitest-environment node
/**
 * A panel that knows a session or a file belongs to ANOTHER project must be able to say so.
 *
 * `openFile` took a path and nothing else, and there was no `openSession` at all, so an
 * extension could only ever act on the project its own window was showing. Both now take the
 * project, and both route through main when it differs, because only main can reach the window
 * that owns another project. When the project is this panel's own, nothing changes: the local
 * callback still runs, with no IPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPanelHost } from '../PanelHostImpl';

vi.mock('../ExtensionFileStorageImpl', () => ({
  ExtensionFileStorageImpl: class {},
}));

const invoke = vi.fn();
const openedLocally: string[] = [];

const host = (workspacePath = '/ws/home') => {
  (globalThis as { window?: unknown }).window = { electronAPI: { invoke, on: vi.fn() } };
  return createPanelHost({
    panelId: 'ext.panel',
    extensionId: 'ext',
    theme: 'dark',
    workspacePath,
    aiSupported: false,
    storage: {} as never,
    onOpenFile: (path: string) => void openedLocally.push(path),
    onOpenPanel: vi.fn(),
    onClose: vi.fn(),
    onThemeChange: () => () => {},
  });
};

describe('PanelHost cross-project navigation', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true });
    openedLocally.length = 0;
  });

  it('opens a file in this project the way it always did, without touching IPC', () => {
    host().openFile('/ws/home/notes.md');
    expect(openedLocally).toEqual(['/ws/home/notes.md']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats naming this panel own project as the local case', () => {
    host().openFile('/ws/home/notes.md', { project: '/ws/home' });
    expect(openedLocally).toEqual(['/ws/home/notes.md']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('routes a file in another project through main, since this window cannot show it', () => {
    host().openFile('/ws/other/plan.md', { project: '/ws/other' });
    expect(openedLocally).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('workspace:open-file-in-project', {
      workspacePath: '/ws/other',
      filePath: '/ws/other/plan.md',
    });
  });

  it('opens a session in this panel own project when no project is named', async () => {
    await host().openSession('sess-1');
    expect(invoke).toHaveBeenCalledWith('sessions:open-in-project', {
      sessionId: 'sess-1',
      workspacePath: '/ws/home',
      sourceLabel: 'ext',
    });
  });

  it('opens a session in another project, and reports whether it got there', async () => {
    expect(await host().openSession('sess-2', { project: '/ws/other' })).toBe(true);
    expect(invoke).toHaveBeenCalledWith('sessions:open-in-project', {
      sessionId: 'sess-2',
      workspacePath: '/ws/other',
      sourceLabel: 'ext',
    });

    invoke.mockResolvedValue({ ok: false, error: 'that project is not open' });
    expect(await host().openSession('sess-3', { project: '/ws/closed' })).toBe(false);
  });

  it('reports failure instead of throwing into the panel when the host call blows up', async () => {
    invoke.mockRejectedValue(new Error('main is gone'));
    expect(await host().openSession('sess-4')).toBe(false);
  });
});
