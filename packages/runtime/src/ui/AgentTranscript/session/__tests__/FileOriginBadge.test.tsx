/**
 * A file from somewhere else. A transcript names files an agent touched, and some of them are
 * in another project or a directory nobody registered. The file still opens here, as it always
 * did; the badge says where it came from and, for a known project, takes you there.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { FileOriginBadge } from '../FileOriginBadge';
import {
  clearFileOriginsAtom,
  fileOriginResolverAtom,
  lookupFileOriginAtom,
  resolvedFileOriginsAtom,
  type FileOrigin,
} from '../fileOriginAtoms';

const { render, screen, fireEvent, cleanup } = rtl;

const ARTINC: FileOrigin = {
  project: 'C:/work/artificial.inc',
  name: 'artificial.inc',
  initials: 'AR',
  color: 'var(--test-artinc)',
  foreign: true,
};
const LOOSE: FileOrigin = { project: null, name: null, initials: null, color: null, foreign: true };
const HOME: FileOrigin = { project: 'C:/work', name: 'work', initials: 'WO', color: 'var(--test-work)', foreign: false };

/** Two badges for one path, both inside a file link, the way a transcript renders them. */
function renderBadges(origin: FileOrigin | null, filePath = 'C:/work/artificial.inc/docs/plan.md') {
  const store = createStore();
  const resolve = vi.fn(async () => origin);
  const openInProject = vi.fn(async () => undefined);
  const onFileClick = vi.fn();
  store.set(fileOriginResolverAtom, { resolve, openInProject });
  render(
    <JotaiProvider store={store}>
      <button type="button" onClick={onFileClick}>
        plan.md
        <FileOriginBadge filePath={filePath} />
        <FileOriginBadge filePath={filePath} />
      </button>
    </JotaiProvider>,
  );
  return { resolve, openInProject, onFileClick };
}

afterEach(cleanup);

describe('FileOriginBadge', () => {
  it('wears the other project initials and opens that project on click, without opening the file', async () => {
    const { openInProject, onFileClick } = renderBadges(ARTINC);
    const badges = await screen.findAllByRole('button', { name: /artificial\.inc/ });
    expect(badges[0].textContent).toBe('AR');
    expect(badges[0].getAttribute('data-foreign')).toBe('true');
    fireEvent.click(badges[0]);
    expect(openInProject).toHaveBeenCalledWith('C:/work/artificial.inc/docs/plan.md', 'C:/work/artificial.inc');
    expect(onFileClick).not.toHaveBeenCalled();
  });

  it('marks a loose directory as outside this project, with nowhere to jump', async () => {
    renderBadges(LOOSE, 'C:/Users/me/.claude/memory/MEMORY.md');
    const badge = (await screen.findAllByTitle(/outside this project/i))[0];
    expect(badge.getAttribute('data-foreign')).toBe('true');
    expect(badge.getAttribute('data-project')).toBeNull();
    expect(badge.tagName).not.toBe('BUTTON');
  });

  it('draws nothing for a file of this project', async () => {
    const { resolve } = renderBadges(HOME);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(document.querySelector('.file-origin-badge')).toBeNull();
  });

  it('asks the host once per path, however many badges show it', async () => {
    const { resolve } = renderBadges(ARTINC);
    await screen.findAllByText('AR');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('draws nothing and asks nothing on a host without a resolver', () => {
    render(
      <JotaiProvider store={createStore()}>
        <FileOriginBadge filePath="C:/anywhere/a.md" />
      </JotaiProvider>,
    );
    expect(document.querySelector('.file-origin-badge')).toBeNull();
  });
});

/**
 * A project whose file list holds tens of thousands of paths mounts that many badges in one
 * commit. Asking and answering one path at a time copied the whole answers map per path and
 * woke every mounted badge each time: quadratic, a window frozen for minutes (66,909 files in
 * an untracked .pnpm-store, 2026-09-20). The cost that matters is writes and round trips per
 * burst, so that is what these pin, not a timing.
 */
describe('file origin lookups for a burst of paths', () => {
  const burst = (count: number) => Array.from({ length: count }, (_, i) => `C:/work/big/.pnpm-store/files/${i}`);

  it('answers the whole burst with one host round trip and one store write', async () => {
    const store = createStore();
    const resolve = vi.fn(async () => HOME);
    const resolveMany = vi.fn(async (paths: string[]) => paths.map(() => HOME));
    store.set(fileOriginResolverAtom, { resolve, resolveMany });
    let writes = 0;
    const unsubscribe = store.sub(resolvedFileOriginsAtom, () => {
      writes += 1;
    });

    for (const filePath of burst(2000)) void store.set(lookupFileOriginAtom, filePath);

    await vi.waitFor(() => expect(store.get(resolvedFileOriginsAtom).size).toBe(2000));
    expect(resolveMany).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(writes).toBe(1);
    unsubscribe();
  });

  it('still writes once for the burst on a host that can only answer one path at a time', async () => {
    const store = createStore();
    const resolve = vi.fn(async () => HOME);
    store.set(fileOriginResolverAtom, { resolve });
    let writes = 0;
    const unsubscribe = store.sub(resolvedFileOriginsAtom, () => {
      writes += 1;
    });

    for (const filePath of burst(500)) void store.set(lookupFileOriginAtom, filePath);

    await vi.waitFor(() => expect(store.get(resolvedFileOriginsAtom).size).toBe(500));
    expect(resolve).toHaveBeenCalledTimes(500);
    expect(writes).toBe(1);
    unsubscribe();
  });

  it('drops answers that land after the window switched project, and lets the path be asked again', async () => {
    const store = createStore();
    let release: (answers: Array<FileOrigin | null>) => void = () => undefined;
    const resolveMany = vi.fn(
      () =>
        new Promise<Array<FileOrigin | null>>((done) => {
          release = done;
        }),
    );
    store.set(fileOriginResolverAtom, { resolve: vi.fn(async () => ARTINC), resolveMany });

    void store.set(lookupFileOriginAtom, 'C:/work/artificial.inc/docs/plan.md');
    await vi.waitFor(() => expect(resolveMany).toHaveBeenCalledTimes(1));
    store.set(clearFileOriginsAtom); // "foreign" is relative to the project on screen
    release([ARTINC]);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(store.get(resolvedFileOriginsAtom).size).toBe(0);

    void store.set(lookupFileOriginAtom, 'C:/work/artificial.inc/docs/plan.md');
    await vi.waitFor(() => expect(resolveMany).toHaveBeenCalledTimes(2));
  });
});

describe('FileOriginBadge, labeled variant for the editor header', () => {
  it('shows "Open in <project>" and jumps there, without opening the file', async () => {
    const store = createStore();
    const openInProject = vi.fn(async () => undefined);
    store.set(fileOriginResolverAtom, { resolve: vi.fn(async () => ARTINC), openInProject });
    render(
      <JotaiProvider store={store}>
        <FileOriginBadge filePath="C:/work/artificial.inc/docs/plan.md" variant="labeled" />
      </JotaiProvider>,
    );
    const button = await screen.findByRole('button', { name: /Open in artificial\.inc/ });
    fireEvent.click(button);
    expect(openInProject).toHaveBeenCalledWith('C:/work/artificial.inc/docs/plan.md', 'C:/work/artificial.inc');
  });

  it('says a loose file is outside this project, with nothing to click', async () => {
    const store = createStore();
    store.set(fileOriginResolverAtom, { resolve: vi.fn(async () => LOOSE), openInProject: vi.fn() });
    render(
      <JotaiProvider store={store}>
        <FileOriginBadge filePath="C:/tmp/x.md" variant="labeled" />
      </JotaiProvider>,
    );
    const badge = (await screen.findAllByText(/Outside this project/i))[0];
    expect(badge.closest('button')).toBeNull();
  });

  it('draws nothing in the header for a file of this project', async () => {
    const store = createStore();
    const resolve = vi.fn(async () => HOME);
    store.set(fileOriginResolverAtom, { resolve, openInProject: vi.fn() });
    render(
      <JotaiProvider store={store}>
        <FileOriginBadge filePath="C:/work/notes.md" variant="labeled" />
      </JotaiProvider>,
    );
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(document.querySelector('.file-origin-badge')).toBeNull();
  });
});
