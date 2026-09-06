import type { ComponentProps, MouseEventHandler } from 'react';
/** Browser documents are native links; desktop hosts retain their open action. */
export declare function SharedDocumentLink({ href, onClick, onContextMenu, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick' | 'onContextMenu'> & {
    href?: string | null;
    onClick?: MouseEventHandler<HTMLElement>;
    onContextMenu?: MouseEventHandler<HTMLElement>;
}): import("react").JSX.Element;
