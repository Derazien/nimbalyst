import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedDocumentLink } from '../SharedDocumentLink';

afterEach(cleanup);
it('leaves browser link activation and context menus to the browser without running desktop open', () => {
  const open = vi.fn();
  const menu = vi.fn();
  render(<SharedDocumentLink href="/org/acme/project/a/document/b?blockId=q" onClick={open} onContextMenu={menu}>Question</SharedDocumentLink>);
  const link = screen.getByRole('link');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('href')).toContain('?blockId=q');
  fireEvent.click(link, { ctrlKey: true });
  expect(fireEvent.contextMenu(link)).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(menu).not.toHaveBeenCalled();
});
