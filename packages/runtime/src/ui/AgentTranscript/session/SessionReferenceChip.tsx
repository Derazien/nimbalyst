/**
 * SessionReferenceChip — inline chip for a reference to another AI session.
 *
 * Resolves the session's live title + phase from `sessionRefByIdAtom` and opens
 * it on click via the `open-ai-session` window event. When the id can't be
 * resolved (unknown / not yet loaded), it degrades to a muted pill showing a
 * shortened id — it never throws and never blocks rendering.
 *
 * Session analog of `TrackerReferenceChip`.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { resolveProviderIcon } from '../../icons/ProviderIcons';
import {
  sessionRefByIdAtom,
  lookupSessionRefAtom,
  openSessionReference,
  type SessionRefMeta,
} from './sessionRefAtoms';

/** Phase -> presentation. Falls back to neutral for unknown phases. */
const PHASE_PRESENTATION: Record<string, { color: string; label: string }> = {
  backlog: { color: 'var(--nim-text-muted)', label: 'Backlog' },
  planning: { color: 'var(--nim-info)', label: 'Planning' },
  implementing: { color: 'var(--nim-warning)', label: 'Implementing' },
  validating: { color: 'var(--nim-info)', label: 'Validating' },
  complete: { color: 'var(--nim-success)', label: 'Complete' },
};

/** Short, stable id label for the unresolved / fallback state. */
export function shortSessionId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function statusDotColor(meta: SessionRefMeta | null): string {
  if (!meta) return 'var(--nim-text-faint)';
  if (meta.isAwaitingInput) return 'var(--nim-warning)';
  if (meta.isProcessing) return 'var(--nim-info)';
  if (meta.phase && PHASE_PRESENTATION[meta.phase]) {
    return PHASE_PRESENTATION[meta.phase].color;
  }
  return 'var(--nim-text-muted)';
}

export interface SessionReferenceChipProps {
  sessionId: string;
  /** Compact chips drop the phase label, keeping the icon + title. */
  variant?: 'default' | 'compact';
  /**
   * Presentation to use when the id isn't in `sessionRefMapAtom` — which the
   * registry only covers for the current workspace. A caller that already has
   * the session's title/provider from its own query (e.g. a session in another
   * worktree) passes it here so the chip shows a name instead of a raw id.
   * Live atom data always wins.
   */
  fallbackMeta?: Partial<SessionRefMeta>;
  /**
   * Host-supplied navigation. Defaults to the `open-ai-session` window event;
   * hosts that already own an open-session action (e.g. the PR pane, which also
   * switches window mode) pass their own here.
   */
  onOpen?: (sessionId: string) => void;
}

export function SessionReferenceChip({
  sessionId,
  variant = 'default',
  fallbackMeta,
  onOpen: onOpenOverride,
}: SessionReferenceChipProps): JSX.Element {
  const liveMeta = useAtomValue(sessionRefByIdAtom(sessionId));
  const lookup = useSetAtom(lookupSessionRefAtom);
  // A session the registry does not know may live in another project. Ask the host once;
  // the atom records hits, misses and in-flight ids, so this is cheap on every render.
  React.useEffect(() => {
    if (!liveMeta) void lookup(sessionId);
  }, [liveMeta, lookup, sessionId]);

  const meta: SessionRefMeta | null =
    liveMeta ?? (fallbackMeta ? { id: sessionId, title: '', ...fallbackMeta } : null);

  const label = meta?.title?.trim() || shortSessionId(sessionId);
  const dotColor = statusDotColor(meta);
  const phase =
    meta?.phase && PHASE_PRESENTATION[meta.phase]
      ? PHASE_PRESENTATION[meta.phase].label
      : undefined;
  const foreignProject = meta?.project?.foreign ? meta.project : null;
  const tooltip = meta
    ? `${meta.title || 'Session'}${phase ? ` · ${phase}` : ''}${foreignProject ? ` · in ${foreignProject.name}` : ''} — open session${foreignProject ? ' in that project' : ''}`
    : `Session ${shortSessionId(sessionId)} — open session`;

  const onOpen = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (onOpenOverride) onOpenOverride(sessionId);
      else openSessionReference(sessionId);
    },
    [sessionId, onOpenOverride],
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      className="session-reference-chip"
      data-session-id={sessionId}
      data-resolved={meta ? 'true' : 'false'}
      data-phase={meta?.phase}
      data-foreign={foreignProject ? 'true' : 'false'}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 7px',
        height: '20px',
        borderRadius: '10px',
        fontSize: '0.85em',
        lineHeight: '1.5',
        verticalAlign: 'baseline',
        cursor: 'pointer',
        background: 'var(--nim-bg-secondary)',
        // The ring is the other project's rail color, so the chip reads as that rail entry.
        border: `1px solid ${foreignProject ? foreignProject.color : 'var(--nim-border)'}`,
        color: 'var(--nim-text)',
        whiteSpace: 'nowrap',
        maxWidth: '40ch',
      }}
    >
      <span
        className="session-reference-chip-icon"
        aria-hidden="true"
        data-provider={meta?.provider}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          lineHeight: 1,
          color: 'var(--nim-text-muted)',
          flexShrink: 0,
        }}
      >
        {/* Custom provider glyphs are SVGs that ignore `style`, so the color
            lives on this wrapper and the SVG inherits it via currentColor. */}
        <MaterialSymbol
          icon={meta?.provider ? resolveProviderIcon(meta.provider) : 'forum'}
          size={13}
        />
      </span>
      <span
        aria-hidden="true"
        className="session-reference-chip-status"
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      {foreignProject ? (
        <span
          className="session-reference-chip-project"
          aria-label={`in ${foreignProject.name}`}
          style={{
            color: foreignProject.color,
            fontWeight: 700,
            fontSize: '0.8em',
            letterSpacing: '0.02em',
            flexShrink: 0,
          }}
        >
          {foreignProject.initials}
        </span>
      ) : null}
      <span
        className="session-reference-chip-title"
        style={{
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      {phase && variant === 'default' ? (
        <span
          className="session-reference-chip-phase"
          style={{ color: 'var(--nim-text-muted)', fontWeight: 500 }}
        >
          {phase}
        </span>
      ) : null}
    </button>
  );
}
