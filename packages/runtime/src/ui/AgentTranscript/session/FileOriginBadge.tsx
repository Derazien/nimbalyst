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
  /**
   * `badge` (default): the compact initials pill, for a transcript line or a list row where
   * space is tight. `labeled`: a wider "Open in {project}" button for the editor header, where
   * the file is already on screen and the reader wants an obvious way to reach its project.
   */
  variant?: 'badge' | 'labeled';
}

export function FileOriginBadge({ filePath, variant = 'badge' }: FileOriginBadgeProps): JSX.Element | null {
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

  if (variant === 'labeled') {
    const labeledStyle: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      marginLeft: '8px',
      padding: '0 8px',
      height: '20px',
      borderRadius: '10px',
      fontSize: '0.75rem',
      fontWeight: 600,
      lineHeight: 1,
      flexShrink: 0,
      background: 'var(--nim-bg-secondary)',
    };
    if (origin.project) {
      const canJump = !!resolver?.openInProject;
      const name = origin.name ?? origin.project;
      return (
        <button
          type="button"
          className="file-origin-badge is-labeled"
          data-foreign="true"
          data-project={origin.project}
          aria-label={`Open in ${name}`}
          title={canJump ? `Open in ${name}` : `In ${name}`}
          onClick={onJump}
          style={{
            ...labeledStyle,
            cursor: canJump ? 'pointer' : 'default',
            color: origin.color ?? 'var(--nim-text)',
            border: `1px solid ${origin.color ?? 'var(--nim-border)'}`,
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: '7px', height: '7px', borderRadius: '50%', background: origin.color ?? 'var(--nim-text-muted)', flexShrink: 0 }}
          />
          <span>Open in {name}</span>
          {canJump ? <MaterialSymbol icon="open_in_new" size={13} /> : null}
        </button>
      );
    }
    return (
      <span
        className="file-origin-badge is-labeled is-outside"
        data-foreign="true"
        aria-label="outside this project"
        title="This file is outside any project"
        style={{ ...labeledStyle, color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
      >
        <MaterialSymbol icon="folder_open" size={13} />
        <span>Outside this project</span>
      </span>
    );
  }

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
