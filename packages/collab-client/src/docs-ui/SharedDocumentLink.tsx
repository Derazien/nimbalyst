import type { ComponentProps, MouseEventHandler } from 'react';

/** Browser documents are native links; desktop hosts retain their open action. */
export function SharedDocumentLink({ href, onClick, onContextMenu, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick' | 'onContextMenu'> & { href?: string | null; onClick?: MouseEventHandler<HTMLElement>; onContextMenu?: MouseEventHandler<HTMLElement> }) {
  if (href) {
    const link = <a {...props} href={href} target="_blank" rel="noopener" onClick={(event) => event.stopPropagation()} />;
    if (!onContextMenu) return link;
    return <span className="shared-document-link-row relative block">
      {link}
      <button type="button" className="shared-document-actions absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 bg-[var(--nim-bg)]" aria-label="Document actions" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(event); }}>⋯</button>
    </span>;
  }
  return <button {...props as ComponentProps<'button'>} type="button" onClick={(event) => { event.stopPropagation(); onClick?.(event); }} onContextMenu={onContextMenu} />;
}
