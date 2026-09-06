import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { CONSOLE_ORIGIN } from '../../shared/consoleOrigin';
import { isLocalIssueKey } from '../../shared/localIssueKey';
import type { DocumentDecisionTrackerInput, DocumentDecisionTrackerResult } from '../../shared/documentDecisionTracker';
import { database } from '../database/PGLiteDatabaseWorker';
import { documentServices } from '../window/WindowManager';
import { resolveTeamForWorkspace } from './TeamService';
import { ensureWorkspaceTrackerSchemasLoaded } from './TrackerSchemaService';
import { resolveTrackerSharingPolicy } from './TrackerPolicyService';
import { ensureTrackerSyncForWorkspace, isTrackerSyncActive, syncTrackerItem } from './TrackerSyncManager';
import { awaitServerIssueKey } from './tracker/awaitServerIssueKey';

const pending = new Map<string, Promise<DocumentDecisionTrackerResult>>();

/** Creates only a new native link card. Never publishes a tracker type or copies a file body. */
export function ensureDocumentDecisionTracker(input: DocumentDecisionTrackerInput): Promise<DocumentDecisionTrackerResult> {
  const key = JSON.stringify([input.workspacePath, input.orgId, input.teamProjectId, input.documentId, input.blockIds]);
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = createOrFind(input).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function createOrFind(input: DocumentDecisionTrackerInput): Promise<DocumentDecisionTrackerResult> {
  if (!input.workspacePath || !input.documentId || !input.title?.trim() || !Array.isArray(input.blockIds) || !input.blockIds.length || input.blockIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('A standalone decision document and its question identifiers are required.');
  }
  const { team } = await resolveTeamForWorkspace(input.workspacePath);
  if (!team || team.orgId !== input.orgId || team.teamProjectId !== input.teamProjectId) {
    throw new Error('The decision tracker destination no longer matches this workspace.');
  }
  ensureWorkspaceTrackerSchemasLoaded(input.workspacePath);
  const policy = resolveTrackerSharingPolicy(input.workspacePath, 'decision');
  if (!policy.known) return { status: 'skipped', reason: 'Tracker link unavailable: the decision tracker schema is unavailable in this workspace.' };
  if (policy.policy.sharing !== 'team') return { status: 'skipped', reason: 'Tracker link unavailable: decision trackers are private in this workspace.' };
  const model = globalRegistry.getForWorkspace(input.workspacePath, 'decision');
  if (model?.creatable === false) return { status: 'skipped', reason: 'Tracker link unavailable: this workspace does not allow creating decision trackers.' };

  const service = documentServices.get(input.workspacePath);
  if (!service) throw new Error('The workspace tracker is still loading. Retry sending.');
  await ensureTrackerSyncForWorkspace(input.workspacePath);
  if (!isTrackerSyncActive(input.workspacePath)) throw new Error('The shared tracker connection is unavailable. Retry sending.');
  const id = `decision-document-${input.documentId}`;
  const url = new URL(`/org/${encodeURIComponent(input.orgId)}/project/${encodeURIComponent(input.teamProjectId)}/document/${encodeURIComponent(input.documentId)}`, CONSOLE_ORIGIN);
  url.searchParams.set('blockId', input.blockIds[0]!);
  let item = await service.getTrackerItemById(id);
  if (!item) {
    try {
      item = await service.createTrackerItem({
        id, type: 'decision', title: input.title.slice(0, 160), status: 'to-do', priority: 'medium', workspace: input.workspacePath,
        description: `[Open the questions and their live outcome](${url.toString()})`,
        source: 'native',
        customFields: {
          decisionId: input.blockIds[0], shared: true,
          linkedDecisionDocumentId: input.documentId, linkedDecisionBlockIds: input.blockIds,
          linkedDecisionOrgId: input.orgId, linkedDecisionProjectId: input.teamProjectId, linkedDecisionUrl: url.toString(),
        },
      });
    } catch (error) {
      // Another window/process may have inserted the same deterministic row.
      // Only the exact native link below is reusable; never overwrite a collision.
      item = await service.getTrackerItemById(id);
      if (!item) throw error;
    }
  }
  const fields = item.customFields;
  if (item.workspace !== input.workspacePath || item.type !== 'decision' || item.source !== 'native' || item.module || fields?.linkedDecisionDocumentId !== input.documentId || fields.linkedDecisionOrgId !== input.orgId || fields.linkedDecisionProjectId !== input.teamProjectId || JSON.stringify(fields.linkedDecisionBlockIds) !== JSON.stringify(input.blockIds)) {
    throw new Error('This decision tracker identifier belongs to a different item. No existing item was changed.');
  }
  // A replay must not upload an old local status over a settled server result.
  if (item.issueKey && !isLocalIssueKey(item.issueKey)) return { status: 'linked', itemId: id, issueKey: item.issueKey };
  await syncTrackerItem(item);
  const issueKey = await awaitServerIssueKey(database, id);
  if (!issueKey) throw new Error('Tracker publication has not been acknowledged. Retry sending to finish addressing the questions.');
  return { status: 'linked', itemId: id, issueKey };
}
