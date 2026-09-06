import React, { useMemo, type RefObject } from 'react';
import type { DecisionsConfig } from '@nimbalyst/runtime/editor/decisions/types';
import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';
import type { CollabLexicalProvider } from '@nimbalyst/runtime/collab-lexical';
import type { CollabDocumentConfig } from '../../utils/collabDocumentOpener';
import { getTeamSyncProvider } from '../../store/atoms/collabDocuments';
import { teamMemberDisplayName } from '../../utils/teamMemberDisplayName';
import { EmbedFrame } from '../EmbedFrame';

/** Both content and addressed delivery use the mounted document's org scope. */
export function useDocumentDecisionsConfig(
  config: CollabDocumentConfig,
  hydrated: boolean,
  lexical: RefObject<CollabLexicalProvider | null>,
  sync: RefObject<DocumentSyncProvider | null>,
): DecisionsConfig {
  return useMemo<DecisionsConfig>(() => ({
    getYDoc: () => lexical.current?.getYDoc() ?? null,
    isHydrated: () => hydrated,
    currentUser: { id: config.teamMemberId, name: config.userName || config.userEmail || config.teamMemberId },
    getMembers: () => (getTeamSyncProvider(config.scope)?.getTeamState()?.members ?? []).map((member) => ({
      id: member.userId, name: teamMemberDisplayName(member), ...(member.email ? { email: member.email } : {}),
    })),
    requestDecision: async (command) => {
      if (!sync.current || !hydrated) throw new Error('The document is still connecting. Try again when it has synced.');
      return sync.current.requestDecision(command);
    },
    getDecisionState: () => sync.current?.getDecisionState() ?? [],
    onDecisionState: (listener) => sync.current?.onDecisionState(listener) ?? (() => {}),
    renderArtifact: (entryId, artifact) => <EmbedFrame src={artifact} label={entryId} attrs={{ height: '200' }} nodeKey={`decision-artifact-${entryId}`} detached />,
  }), [config, hydrated, lexical, sync]);
}
