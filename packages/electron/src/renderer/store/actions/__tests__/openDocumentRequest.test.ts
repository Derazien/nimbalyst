// @vitest-environment node
/**
 * Main asks a window to open a document. When that document belongs to a project the window
 * hosts on its rail but is not showing, the request waits in the pending-open queue for a
 * project that is not on screen and the "Open in <project>" button appears to do nothing. The
 * rail must switch first; a request with no project, which is every legacy sender, opens as
 * before.
 */
import { describe, expect, it, vi } from 'vitest';
import { routeOpenDocumentRequest } from '../openDocumentRequest';

const deps = (over: Partial<Parameters<typeof routeOpenDocumentRequest>[1]> = {}) => ({
  activeWorkspace: 'C:/work/locallead',
  activateProject: vi.fn(async () => true),
  ...over,
});

describe('routeOpenDocumentRequest', () => {
  it('leaves the rail alone for a request with no project', async () => {
    const d = deps();
    expect(await routeOpenDocumentRequest({ path: 'C:/anywhere/a.md' }, d)).toBe('here');
    expect(d.activateProject).not.toHaveBeenCalled();
  });

  it('does not switch for a file of the project on screen, whatever the path spelling', async () => {
    const d = deps();
    expect(
      await routeOpenDocumentRequest({ path: 'C:/work/locallead/a.md', workspacePath: 'c:\\work\\LOCALLEAD' }, d),
    ).toBe('here');
    expect(d.activateProject).not.toHaveBeenCalled();
  });

  it('switches the rail to the file project', async () => {
    const d = deps();
    expect(
      await routeOpenDocumentRequest(
        { path: 'C:/work/artificial.inc/docs/a.md', workspacePath: 'C:/work/artificial.inc' },
        d,
      ),
    ).toBe('switched');
    expect(d.activateProject).toHaveBeenCalledWith('C:/work/artificial.inc');
  });

  it('reports unreachable when the project cannot be activated, so the caller opens it here', async () => {
    const d = deps({ activateProject: vi.fn(async () => false) });
    expect(
      await routeOpenDocumentRequest(
        { path: 'C:/work/artificial.inc/docs/a.md', workspacePath: 'C:/work/artificial.inc' },
        d,
      ),
    ).toBe('unreachable');
  });
});
