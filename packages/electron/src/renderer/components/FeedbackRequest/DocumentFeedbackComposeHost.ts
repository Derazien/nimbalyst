import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { buildCollabUri, decisionAskFromSource } from '@nimbalyst/collab-protocol';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { parseDecisionFence } from '@nimbalyst/runtime/editor/plugins/DecisionPlugin/decisionFence';
import { $createDecisionNode, $isDecisionNode, readDecisionIdFromFence } from '@nimbalyst/runtime/editor/plugins/DecisionPlugin/DecisionNode';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import type { FeedbackComposeSendPayload } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/feedback/feedbackComposeDraft';
import type { FeedbackRequestSendResult } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import { acquireHeadlessCollabDocument, assertDecodable } from '../../services/HeadlessCollabDocument';
import { createCollaborativeDocument } from '../../services/collaborativeDocumentCreationOrchestrator';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { getSharedDocumentsForScope, resolveDesktopCollabScope } from '../../store/atoms/collabDocuments';
import { buildSharedDocumentDeepLink } from '../../utils/collabArtifactDeepLinks';
import { openSharedDocumentInTab } from '../../utils/openSharedDocumentInTab';
import { CONSOLE_ORIGIN } from '../../../shared/consoleOrigin';
import type { DocumentDecisionTrackerResult } from '../../../shared/documentDecisionTracker';
import { decisionBlocksForFeedback, type AuthoredDecisionBlock } from './documentFeedbackDraft';
import type { ResolvedFeedbackDestination } from './feedbackDestinationFolder';

/** Add only missing blocks. Existing prose, comments, votes and seals stay put. */
export function appendFeedbackDecisionBlocks(editor: LexicalEditor, blocks: readonly AuthoredDecisionBlock[]): void {
  let failure: string | undefined;
  editor.update(() => {
    const existing = new Map<string, string>();
    const visit = (node: LexicalNode): void => {
      if ($isDecisionNode(node)) {
        existing.set(readDecisionIdFromFence(node.getContent()), node.getContent());
      } else if ($isElementNode(node)) node.getChildren().forEach(visit);
    };
    visit($getRoot());
    for (const block of blocks) {
      const previous = existing.get(block.blockId);
      if (!previous) continue;
      const saved = parseDecisionFence(previous);
      const proposed = parseDecisionFence(block.content);
      if (!saved || !proposed || JSON.stringify(decisionAskFromSource(saved)) !== JSON.stringify(decisionAskFromSource(proposed))) {
        failure = 'A question from this draft already exists with different content. Open its document before sending again.';
        return;
      }
    }
    for (const block of blocks) {
      if (!existing.has(block.blockId)) $getRoot().append($createDecisionNode({ content: block.content }));
    }
  }, { discrete: true });
  if (failure) throw new Error(failure);
}

async function stableDocumentId(orgId: string, sessionId: string, draftId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([orgId, sessionId, draftId]))));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function sendDocumentFeedback(
  config: { workspacePath: string; sessionId: string; sessionName?: string },
  payload: FeedbackComposeSendPayload,
  destination?: ResolvedFeedbackDestination,
): Promise<FeedbackRequestSendResult> {
  const { scope } = await resolveDesktopCollabScope(config.workspacePath);
  if (!scope || scope.orgId !== payload.orgId) throw new Error('The current workspace is not connected to this organization.');
  const projectId = scope.indexConfig.teamProjectId;
  if (!projectId) throw new Error('This workspace has no shared project destination.');
  const blocks = decisionBlocksForFeedback(payload);
  const documents = getSharedDocumentsForScope(scope);
  const retryId = await stableDocumentId(payload.orgId, config.sessionId, payload.draftId);
  // A previous standalone send owns its host even if the draft's subject list
  // was subsequently changed. Never create a second host on retry.
  let document = documents.find((candidate) => candidate.documentId === retryId);
  if (payload.hostDocumentId) {
    const approvedSubject = payload.subjects.some((subject) => subject.ref.kind === 'document' && subject.ref.orgId === payload.orgId && subject.ref.sourceId === payload.hostDocumentId);
    if (!approvedSubject) throw new Error('The host document is not one of the approved subjects.');
    document = documents.find((candidate) => candidate.documentId === payload.hostDocumentId && candidate.documentType === 'markdown');
    if (!document) throw new Error('The approved host is not an available shared markdown document.');
  }
  if (!document) {
    const resolution = getCollaborativeDocumentTypeCatalog().resolveMetadata('markdown', '.md');
    if (resolution.state !== 'ready') throw new Error('The shared markdown editor is unavailable.');
    const title = (payload.asks[0]?.label ?? 'Decision').replace(/[\\/:*?"<>|\n\r]/g, ' ').trim().slice(0, 80) || 'Decision';
    const body = [
      `---\ntrackerStatus:\n  type: decision\ndecisionId: ${blocks[0]!.blockId}\nstatus: to-do\nchosen: ''\n---\n\n# ${title}`,
      ...payload.subjects.filter((subject) => subject.ref.kind === 'document').map((subject) => {
        const target = documents.find((candidate) => candidate.documentId === subject.ref.sourceId);
        const extension = target?.fileExtension ?? (target && getCollaborativeDocumentTypeCatalog().inferFileExtension(target.documentType, target.title));
        const label = subject.label.replace(/[\r\n\[\]]/g, ' ').trim() || 'Shared document';
        const href = buildSharedDocumentDeepLink(subject.ref.sourceId, payload.orgId);
        // Shared targets have no suffix in their URL; the title retains the
        // registered editor type for the CommonMark link-to-embed importer.
        return `[${label}](${href}${extension ? ` "embedType=${extension}"` : ''})`;
      }),
      ...blocks.map((block) => `\`\`\`decision\n${block.content}\n\`\`\``),
    ].join('\n\n');
    document = await createCollaborativeDocument({
      scope, descriptor: resolution.descriptor, requestedName: `${title} ${retryId.slice(0, 6)}.md`,
      parentFolderId: destination?.folderId ?? payload.destination?.folderId ?? null,
      documentId: retryId, operationId: `decision-${retryId}`, sourceContent: body,
      openAfterCreate: false, analyticsSource: 'agent_tool', analyticsActorType: 'user',
    });
  }
  const uri = buildCollabUri(payload.orgId, document.documentId);
  const acquisition = await acquireHeadlessCollabDocument(uri, scope.scopeKey);
  let warning: string | undefined;
  try {
    assertDecodable(acquisition, uri);
    const mounted = editorRegistry.getEditor(uri);
    if (mounted) appendFeedbackDecisionBlocks(mounted.editor, blocks);
    else withHeadlessLexicalBridge(acquisition.yDoc, { nodes: HeadlessBodyNodes, namespace: 'document-feedback-compose' }, (bridge) => appendFeedbackDecisionBlocks(bridge.editor, blocks));
    // Let the mounted Lexical provider forward its committed transaction before
    // the network provider takes the acknowledged snapshot for addressing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!acquisition.syncProvider.requestDecision) throw new Error('Document question delivery is unavailable in this connection.');
    if (!payload.hostDocumentId) {
      const tracker = await window.electronAPI.invoke('document-decision:ensure-tracker', {
        workspacePath: config.workspacePath, orgId: payload.orgId, teamProjectId: projectId,
        documentId: document.documentId, blockIds: blocks.map((block) => block.blockId),
        title: payload.asks[0]?.label ?? 'Decision',
      }) as DocumentDecisionTrackerResult;
      if (tracker.status === 'skipped') warning = tracker.reason;
    }
    for (const block of blocks) {
      await acquisition.syncProvider.requestDecision({ operation: 'send', blockId: block.blockId, recipientIds: block.recipientIds, quorum: block.quorum, sessionId: config.sessionId });
    }
  } finally { acquisition.release(); }
  openSharedDocumentInTab({ orgId: payload.orgId, projectId, kind: 'document', sourceId: document.documentId }, 'feedback_request');
  const url = new URL(`/org/${encodeURIComponent(payload.orgId)}/project/${encodeURIComponent(projectId)}/document/${encodeURIComponent(document.documentId)}`, CONSOLE_ORIGIN);
  url.searchParams.set('blockId', blocks[0]!.blockId);
  return { success: true, requestId: blocks[0]!.blockId, shareUrl: url.toString(), ...(warning ? { warning } : {}) };
}
