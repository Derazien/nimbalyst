/**
 * SessionReferenceChip icon + navigation contract.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { SessionReferenceChip } from '../SessionReferenceChip';
import { sessionRefMapAtom, type SessionRefMeta } from '../sessionRefAtoms';

const { render, screen, fireEvent, cleanup } = rtl;

const SESSION_ID = '9b1f2a44-1c22-4f0e-9a10-1234567890ab';

function renderChip(meta?: SessionRefMeta, onOpen?: (id: string) => void) {
  const store = createStore();
  if (meta) store.set(sessionRefMapAtom, new Map([[meta.id, meta]]));
  return render(
    <JotaiProvider store={store}>
      <SessionReferenceChip sessionId={SESSION_ID} onOpen={onOpen} />
    </JotaiProvider>,
  );
}

afterEach(cleanup);

describe('SessionReferenceChip', () => {
  it('renders the session provider glyph instead of the generic icon', () => {
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review', provider: 'claude-code' });

    const icon = document.querySelector('.session-reference-chip-icon');
    expect(icon?.getAttribute('data-provider')).toBe('claude-code');
    // `claude-code` is a custom brand SVG, not a material-symbols ligature.
    expect(icon?.querySelector('svg')).toBeTruthy();
    expect(icon?.textContent).not.toContain('forum');
    screen.getByText('PR 978 contribution review');
  });

  it('falls back to the generic forum glyph when the provider is unknown', () => {
    renderChip({ id: SESSION_ID, title: 'Untitled session' });

    const icon = document.querySelector('.session-reference-chip-icon');
    expect(icon?.textContent).toBe('forum');
  });

  it('uses the host-supplied open handler instead of the window event', () => {
    const onOpen = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review' }, onOpen);

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(onOpen).toHaveBeenCalledWith(SESSION_ID);
    expect(
      dispatch.mock.calls.some(([event]) => (event as CustomEvent).type === 'open-ai-session'),
    ).toBe(false);
    dispatch.mockRestore();
  });

  it('dispatches open-ai-session when no handler is supplied', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review' });

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(
      dispatch.mock.calls.some(([event]) => (event as CustomEvent).type === 'open-ai-session'),
    ).toBe(true);
    dispatch.mockRestore();
  });
});

/**
 * A session in ANOTHER project. The chip used to know only this window's sessions, so a
 * foreign id drew dim with a bare id and a click opened it under the wrong project. Now the
 * host can hand the chip a project (with the rail's initials and color) and a resolver for
 * ids it does not know yet.
 */
import { sessionRefResolverAtom } from '../sessionRefAtoms';

const FOREIGN = {
  path: 'C:/work/artificial.inc',
  name: 'artificial.inc',
  initials: 'AR',
  color: 'var(--test-artinc)',
  foreign: true,
};

describe('SessionReferenceChip, another project', () => {
  it('wears the other project initials in its color and says so in the tooltip', () => {
    renderChip({ id: SESSION_ID, title: 'Smoke test', provider: 'claude-code', project: FOREIGN });
    const chip = document.querySelector('.session-reference-chip') as HTMLElement;
    expect(chip.getAttribute('data-foreign')).toBe('true');
    const badge = chip.querySelector('.session-reference-chip-project') as HTMLElement;
    expect(badge.textContent).toBe('AR');
    expect(badge.getAttribute('aria-label')).toBe('in artificial.inc');
    expect(chip.title).toContain('artificial.inc');
  });

  it('wears nothing extra for a session in this project', () => {
    renderChip({ id: SESSION_ID, title: 'Local', project: { ...FOREIGN, path: 'C:/work', name: 'work', initials: 'WO', foreign: false } });
    const chip = document.querySelector('.session-reference-chip') as HTMLElement;
    expect(chip.getAttribute('data-foreign')).toBe('false');
    expect(chip.querySelector('.session-reference-chip-project')).toBeNull();
  });

  it('asks the host resolver once for an id it does not know, then renders the answer', async () => {
    const resolver = vi.fn(async (id: string) => ({ id, title: 'Found elsewhere', project: FOREIGN }));
    const store = createStore();
    store.set(sessionRefResolverAtom, { resolve: resolver });
    render(
      <JotaiProvider store={store}>
        <SessionReferenceChip sessionId={SESSION_ID} />
        <SessionReferenceChip sessionId={SESSION_ID} variant="compact" />
      </JotaiProvider>,
    );
    expect((await screen.findAllByText('Found elsewhere')).length).toBe(2);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(SESSION_ID);
  });

  it('stays a dim id when the resolver has nothing, and does not ask again', async () => {
    const resolver = vi.fn(async () => null);
    const store = createStore();
    store.set(sessionRefResolverAtom, { resolve: resolver });
    const { rerender } = render(
      <JotaiProvider store={store}>
        <SessionReferenceChip sessionId={SESSION_ID} />
      </JotaiProvider>,
    );
    await screen.findByText(SESSION_ID.slice(0, 8));
    rerender(
      <JotaiProvider store={store}>
        <SessionReferenceChip sessionId={SESSION_ID} />
      </JotaiProvider>,
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.session-reference-chip')?.getAttribute('data-resolved')).toBe('false');
  });
});
