/** Local live-proof fixture: real comment store, MarkNode, agent diff, and approval. */
import type { Doc } from 'yjs';
import { $wrapSelectionInMarkNode } from '@lexical/mark';
import { $createRangeSelection, $getRoot, $setSelection } from 'lexical';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import type { HeadlessLexicalYDoc } from '@nimbalyst/runtime/sync/HeadlessLexicalYDoc';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import { CommentStore, createComment, createThread } from '@nimbalyst/runtime/editor/commenting';
import { CommentCollabProvider } from '@nimbalyst/runtime/editor/commenting/CommentCollabProvider';
import { createCollabCommentController } from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import { $approveDiffs } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffPluginUtils';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync/MarkdownCollabContentAdapter';
import { applyMarkdownReplacementsToYDoc } from '../headlessMarkdownEdit';

export const LIVE_THREAD = 'thread-live-decision';
export const LIVE_COMMENT = 'comment-live-decision';
export const LIVE_QUOTE = 'survives tab close';
export const LIVE_BODY = 'Keep this constraint in the settled decision.';

function withCommentEditor<T>(doc: Doc, fn: (context: {
  headless: HeadlessLexicalYDoc;
  store: CommentStore;
  controller: ReturnType<typeof createCollabCommentController>;
}) => T): T {
  return withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, (headless) => {
    const store = new CommentStore(headless.editor);
    const detach = store.registerCollaboration(new CommentCollabProvider(doc));
    const controller = createCollabCommentController({
      commentStore: store, editor: headless.editor,
      currentUser: { id: 'local-proof-reviewer', name: 'Reviewer' },
      documentUri: 'collab://org:local-proof:doc:decision',
      getCapabilities: () => ({ read: true, comment: true }), getMembers: () => [],
      isHydrated: () => true, isVisible: () => false,
    });
    try { return fn({ headless, store, controller }); } finally { detach(); }
  });
}

export function attachLiveDecisionComment(doc: Doc) {
  withCommentEditor(doc, ({ headless, store }) => {
    headless.applyUpdate(() => {
      const text = $getRoot().getAllTextNodes().find(node => node.getTextContent().includes(LIVE_QUOTE));
      if (!text) throw new Error('Live proof quote missing');
      const offset = text.getTextContent().indexOf(LIVE_QUOTE);
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), offset, 'text');
      selection.focus.set(text.getKey(), offset + LIVE_QUOTE.length, 'text');
      $setSelection(selection);
      $wrapSelectionInMarkNode(selection, false, LIVE_THREAD);
      $setSelection(null);
    });
    store.addComment(createThread(LIVE_QUOTE, [createComment(LIVE_BODY, 'Reviewer', LIVE_COMMENT)], LIVE_THREAD));
  });
  return readLiveDecisionComment(doc);
}

export function readLiveDecisionComment(doc: Doc) {
  return withCommentEditor(doc, ({ controller }) => {
    const thread = controller.list().threads.find(entry => entry.id === LIVE_THREAD);
    if (thread?.anchorState !== 'attached' || !thread.comments.some(comment => comment.id === LIVE_COMMENT && comment.body === LIVE_BODY)) {
      throw new Error(`Real comment anchor or body missing: ${JSON.stringify(thread)}`);
    }
    return { threadId: thread.id, commentId: LIVE_COMMENT, anchorState: thread.anchorState, quote: thread.quote, body: LIVE_BODY };
  });
}

export function editAndApproveLiveDecision(doc: Doc) {
  const content = MarkdownCollabContentAdapter.exportToFile(doc) as string;
  const fence = content.match(/```decision\n[\s\S]*?\n```/)?.[0];
  if (!fence) throw new Error('Live decision fence missing for agent edit');
  applyMarkdownReplacementsToYDoc(doc, [
    { oldText: 'Native tab durable edit', newText: 'Agent-reviewed native tab durable edit' },
    { oldText: fence, newText: fence.replace('Ship the browser feedback workflow?', 'Ship the reviewed browser feedback workflow?') },
  ]);
  const afterDiff = readLiveDecisionComment(doc);
  withCommentEditor(doc, ({ headless }) => headless.applyUpdate($approveDiffs));
  return { afterDiff, afterApproval: readLiveDecisionComment(doc) };
}
