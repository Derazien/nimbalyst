// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createHeadlessEditor } from '@lexical/headless';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { CORE_TRANSFORMERS } from '@nimbalyst/runtime/editor/markdown/core-transformers';
import { IMAGE_TRANSFORMER } from '@nimbalyst/runtime/editor/plugins/ImagesPlugin/ImageTransformer';
import { CollabDocumentReferenceTransformer } from '@nimbalyst/runtime/plugins/DocumentLinkPlugin/DocumentLinkNode';
import { $rescanForEmbedUpgrade } from '@nimbalyst/runtime/editor/extensions/builtin/EmbedExtension';
import { $isEmbeddedFileNode } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { setEmbeddableExtensions } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/embeddableExtensions';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { $isDecisionNode } from '@nimbalyst/runtime/editor/plugins/DecisionPlugin/DecisionNode';
import { parseDecisionFence } from '@nimbalyst/runtime/editor/plugins/DecisionPlugin/decisionFence';
import { decisionBlocksForFeedback } from '../documentFeedbackDraft';
import type { FeedbackComposeSendPayload } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/feedback/feedbackComposeDraft';

const host = vi.hoisted(() => ({
  acquire: vi.fn(), create: vi.fn(), open: vi.fn(), invoke: vi.fn(),
  documents: [{ documentId: 'doc-existing', documentType: 'markdown', title: 'Existing plan.md', fileExtension: '.md' }, { documentId: 'mockup-1', documentType: 'mockup.html', title: 'Preview', fileExtension: '.mockup.html' }],
}));
vi.mock('../../../services/HeadlessCollabDocument', () => ({ acquireHeadlessCollabDocument: host.acquire, assertDecodable: () => {} }));
vi.mock('../../../services/collaborativeDocumentCreationOrchestrator', () => ({ createCollaborativeDocument: host.create }));
vi.mock('../../../services/CollaborativeDocumentTypeCatalog', () => ({ getCollaborativeDocumentTypeCatalog: () => ({ resolveMetadata: () => ({ state: 'ready', descriptor: { documentType: 'markdown' } }) }) }));
vi.mock('../../../store/atoms/collabDocuments', () => ({
  resolveDesktopCollabScope: async () => ({ scope: { orgId: 'org-1', scopeKey: '/work', indexConfig: { teamProjectId: 'server-project' } } }),
  getSharedDocumentsForScope: () => host.documents,
}));
vi.mock('../../../utils/openSharedDocumentInTab', () => ({ openSharedDocumentInTab: host.open }));
import { appendFeedbackDecisionBlocks, sendDocumentFeedback } from '../DocumentFeedbackComposeHost';

const payload: FeedbackComposeSendPayload = {
  draftId: 'draft-1', orgId: 'org-1', hostDocumentId: 'doc-existing',
  subjects: [{ ref: { kind: 'document', sourceId: 'doc-existing', orgId: 'org-1' }, label: 'Existing plan.md' }],
  asks: [{ id: 'approve', type: 'confirm', label: 'Ship?', description: 'Review this direction.' }],
  recipients: [{ userId: 'karl', name: 'Karl' }], assignments: [{ askId: 'approve', target: { kind: 'user', userId: 'karl' } }],
  visibility: 'open', wakePolicy: 'quorumOrClose', quorum: { requiredRecipientCount: 1 }, publishSubjectRefs: [],
};

function read(doc: Y.Doc) {
  return withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, ({ editor }) => editor.getEditorState().read(() => $getRoot().getChildren().map((node) => ({ text: node.getTextContent(), decision: $isDecisionNode(node) }))));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { electronAPI: { invoke: host.invoke } });
});

describe('document feedback send', () => {
  it('imports shared visual subjects as live embeds and markdown subjects as document links', async () => {
    host.acquire.mockResolvedValue({ yDoc: new Y.Doc(), syncProvider: { requestDecision: vi.fn().mockResolvedValue({ decisions: [] }) }, release: vi.fn() });
    host.create.mockImplementation(async (input) => ({ documentId: input.documentId, documentType: 'markdown' }));
    host.invoke.mockResolvedValue({ status: 'linked' });
    await sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, {
      ...payload, hostDocumentId: undefined,
      subjects: [...payload.subjects, { ref: { kind: 'document', sourceId: 'mockup-1', orgId: 'org-1' }, label: 'Visual preview' }],
    });
    const markdown = host.create.mock.calls[0]![0].sourceContent;
    const editor = createHeadlessEditor({ nodes: HeadlessBodyNodes, onError: (error) => { throw error; } });
    setEmbeddableExtensions(['.mockup.html']);
    try {
      editor.update(() => {
        $convertFromMarkdownString(markdown, [IMAGE_TRANSFORMER, CollabDocumentReferenceTransformer, ...CORE_TRANSFORMERS]);
        $rescanForEmbedUpgrade();
      }, { discrete: true });
      editor.read(() => {
        const embeds = $getRoot().getChildren().filter($isEmbeddedFileNode);
        expect(embeds).toHaveLength(1);
        expect(embeds[0]!.getSrc()).toBe('nimbalyst://doc/mockup-1?orgId=org-1');
        expect(embeds[0]!.getAttrs().embedType).toBe('.mockup.html');
        const serialized = JSON.stringify(editor.getEditorState().toJSON());
        expect(serialized).not.toContain('"type":"image"');
        expect(serialized).toContain('"type":"document-reference"');
      });
    } finally { setEmbeddableExtensions([]); }
  });

  it('requires standalone tracker acknowledgement before addressing recipients and retries the same document', async () => {
    const doc = new Y.Doc();
    const send = vi.fn().mockResolvedValue({ decisions: [] });
    const release = vi.fn();
    host.acquire.mockResolvedValue({ yDoc: doc, syncProvider: { requestDecision: send }, release });
    host.create.mockImplementation(async (input) => ({ documentId: input.documentId, documentType: 'markdown' }));
    host.invoke.mockRejectedValueOnce(new Error('Tracker publication has not been acknowledged. Retry sending.'));
    const standalone = { ...payload, hostDocumentId: undefined };
    await expect(sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, standalone)).rejects.toThrow('Tracker publication');
    expect(send).not.toHaveBeenCalled();
    host.invoke.mockResolvedValue({ status: 'linked', itemId: 'tracker-id', issueKey: 'NIM-1' });
    await sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, standalone);
    expect(host.create.mock.calls[0]![0].documentId).toBe(host.create.mock.calls[1]![0].documentId);
    expect(host.invoke).toHaveBeenCalledWith('document-decision:ensure-tracker', expect.objectContaining({ orgId: 'org-1', teamProjectId: 'server-project', blockIds: ['dcn-draft-1-approve'] }));
    expect(send).toHaveBeenCalledOnce();
  });

  it('sends the document and returns a visible warning when tracker sharing is unavailable', async () => {
    host.acquire.mockResolvedValue({ yDoc: new Y.Doc(), syncProvider: { requestDecision: vi.fn().mockResolvedValue({ decisions: [] }) }, release: vi.fn() });
    host.create.mockImplementation(async (input) => ({ documentId: input.documentId, documentType: 'markdown' }));
    host.invoke.mockResolvedValue({ status: 'skipped', reason: 'Decision trackers are private in this workspace.' });
    const result = await sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, { ...payload, hostDocumentId: undefined });
    expect(result).toMatchObject({ success: true, warning: 'Decision trackers are private in this workspace.' });
  });

  it('appends through the real bridge, preserves existing prose and votes, and replays without duplicate questions', async () => {
    const doc = new Y.Doc();
    withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, ({ editor }) => editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Existing anchored prose.'))), { discrete: true }));
    const before = read(doc)[0]!.text;
    doc.getMap('decisions').set('older\x1fkarl', { voterId: 'karl', answer: { type: 'confirm', value: true } });
    const release = vi.fn();
    const send = vi.fn().mockResolvedValue({ decisions: [] });
    host.acquire.mockResolvedValue({ yDoc: doc, syncProvider: { requestDecision: send }, release });
    const first = await sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, payload);
    const second = await sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, payload);
    expect(read(doc).filter((entry) => entry.decision)).toHaveLength(1);
    expect(read(doc)[0]!.text).toBe(before);
    expect(doc.getMap('decisions').get('older\x1fkarl')).toMatchObject({ voterId: 'karl' });
    expect(first).toEqual(second);
    expect(first.shareUrl).toContain('/project/server-project/document/doc-existing?blockId=dcn-draft-1-approve');
    expect(send).toHaveBeenCalledWith({ operation: 'send', blockId: 'dcn-draft-1-approve', recipientIds: ['karl'], quorum: 1, sessionId: 'session-1' });
    expect(release).toHaveBeenCalledTimes(2);
    expect(host.create).not.toHaveBeenCalled();
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('releases the acquisition and reports failure without opening a success view if server acknowledgement fails', async () => {
    const doc = new Y.Doc();
    const release = vi.fn();
    host.acquire.mockResolvedValue({ yDoc: doc, release, syncProvider: { requestDecision: vi.fn().mockRejectedValue(new Error('No server acknowledgement')) } });
    await expect(sendDocumentFeedback({ workspacePath: '/work', sessionId: 'session-1' }, payload)).rejects.toThrow('No server acknowledgement');
    expect(release).toHaveBeenCalledOnce();
    expect(host.open).not.toHaveBeenCalled();
  });

  it('preserves already answered questions when an edited compose draft replays', () => {
    const doc = new Y.Doc();
    const blocks = decisionBlocksForFeedback(payload);
    withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, ({ editor }) => appendFeedbackDecisionBlocks(editor, blocks));
    const changed = decisionBlocksForFeedback({ ...payload, asks: [{ ...payload.asks[0]!, label: 'A different question?' }] });
    expect(() => withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, ({ editor }) => appendFeedbackDecisionBlocks(editor, changed))).toThrow('different content');
    expect(read(doc).filter((entry) => entry.decision)).toHaveLength(1);
    expect(parseDecisionFence(read(doc).find((entry) => entry.decision)!.text)?.ask).toBe('Ship?');
  });
});


it('preserves artifact references, per-question assignment, and draft grouping when building blocks', () => {
  const blocks = decisionBlocksForFeedback({ ...payload, asks: [{ id: 'layout', type: 'singleSelect', label: 'Layout?', description: '', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], artifacts: [{ entryId: 'a', ref: { kind: 'document', orgId: 'org-1', sourceId: 'mockup-a' }, label: 'A' }] }], assignments: [{ askId: 'layout', target: { kind: 'user', userId: 'karl' } }] });
  const source = parseDecisionFence(blocks[0]!.content)!;
  expect(source.entries[0]?.artifact).toBe('collab://org:org-1:doc:mockup-a');
  expect(source.raw.feedbackDraftId).toBe('draft-1');
  expect(source.raw.feedbackAskId).toBe('layout');
  expect(blocks[0]!.recipientIds).toEqual(['karl']);
});
