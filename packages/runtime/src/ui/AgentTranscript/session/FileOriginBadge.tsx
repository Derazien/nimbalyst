/**
 * FileOriginBadge: a small mark next to a file name that says the file is not from the project
 * on screen.
 *
 * A known project draws as that project's rail initials in its color, and clicking the badge
 * opens the file in that project's window. A directory nobody registered draws as a muted
 * folder mark with nowhere to jump. A file of this project draws nothing at all, so the common
 * case costs nothing on screen.
 *
 * The click never reaches the file link the badge sits inside: the badge is a jump, the link
 * is an open, and both on one click would open the file twice in two windows.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import { MaterialSymbol } from '../../icons/MaterialSymbol';
import {
  fileOriginByPathAtom,
  fileOriginResolverAtom,
  lookupFileOriginAtom,
} from './fileOriginAtoms';

export interface FileOriginBadgeProps {
  filePath: string;
}

export function FileOriginBadge({ filePath }: FileOriginBadgeProps): JSX.Element | null {
  const origin = useAtomValue(fileOriginByPathAtom(filePath));
  const resolver = useAtomValue(fileOriginResolverAtom);
  const lookup = useSetAtom(lookupFileOriginAtom);

  React.useEffect(() => {
    if (resolver) void lookup(filePath);
  }, [filePath, lookup, resolver]);

  const onJump = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (origin?.project && resolver?.openInProject) {
        void resolver.openInProject(filePath, origin.project);
      }
    },
    [filePath, origin, resolver],
  );

  if (!origin?.foreign) return null;

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: '4px',
    padding: '0 4px',
    height: '16px',
    borderRadius: '8px',
    fontSize: '0.7em',
    fontWeight: 700,
    letterSpacing: '0.02em',
    lineHeight: 1,
    verticalAlign: 'middle',
    flexShrink: 0,
  };

  if (origin.project && origin.initials) {
    const canJump = !!resolver?.openInProject;
    return (
      <button
        type="button"
        className="file-origin-badge"
        data-foreign="true"
        data-project={origin.project}
        aria-label={`in ${origin.name ?? origin.project}${canJump ? ', open there' : ''}`}
        title={`in ${origin.name ?? origin.project}${canJump ? ' — open there' : ''}`}
        onClick={onJump}
        style={{
          ...baseStyle,
          cursor: canJump ? 'pointer' : 'default',
          color: origin.color ?? 'var(--nim-text-muted)',
          background: 'var(--nim-bg-secondary)',
          border: `1px solid ${origin.color ?? 'var(--nim-border)'}`,
        }}
      >
        {origin.initials}
      </button>
    );
  }

  return (
    <span
      className="file-origin-badge is-outside"
      data-foreign="true"
      aria-label="outside this project"
      title="outside this project"
      style={{
        ...baseStyle,
        color: 'var(--nim-text-muted)',
        background: 'var(--nim-bg-secondary)',
        border: '1px solid var(--nim-border)',
      }}
    >
      <MaterialSymbol icon="folder_open" size={12} />
    </span>
  );
}
