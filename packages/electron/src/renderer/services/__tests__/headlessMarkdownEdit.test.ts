// @vitest-environment node
/**
 * Headless markdown edits produce a MINIMAL delta.
 *
 * This is the whole reason the markdown path reconciles through the editor
 * instead of taking the codec's cheap `clear + reparse`. A wholesale
 * replacement still ends up with the right text, so asserting on the resulting
 * document cannot tell the two apart -- and the difference is exactly what
 * decides whether a remote collaborator's in-flight edit survives and whether
 * comment anchors stay attached.
 *
 * So these assert on the Yjs UPDATE, not the result. The control case below
 * runs the same assertion against the wipe-and-reseed path and expects the
 * opposite, so a regression cannot pass by making the assertion vacuous.
 */
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync/MarkdownCollabContentAdapter';
import { $wrapSelectionInMarkNode } from '@lexical/mark';
import { $createRangeSelection, $getRoot, $setSelection } from 'lexical';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import type { HeadlessLexicalYDoc } from '@nimbalyst/runtime/sync/HeadlessLexicalYDoc';
import {
  CommentStore,
  createComment,
  createThread,
} from '@nimbalyst/runtime/editor/commenting';
import { CommentCollabProvider } from '@nimbalyst/runtime/editor/commenting/CommentCollabProvider';
import { createCollabCommentController } from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import {
  $approveDiffs,
  $rejectDiffs,
  $approveChangeGroup,
  $rejectChangeGroup,
} from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffPluginUtils';
import {
  $getDiffState,
  $getOriginalMarkdown,
} from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/DiffState';
import { groupDiffChanges } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffChangeGroups';

import { applyMarkdownReplacementsToYDoc } from '../headlessMarkdownEdit';

const UNTOUCHED = 'Paragraph three is a bystander and must not be rewritten.';
const ORIGINAL = [
  '# Heading',
  '',
  'Paragraph one mentions alpha.',
  '',
  'Paragraph two mentions beta.',
  '',
  UNTOUCHED,
  '',
].join('\n');

/** Yjs stores inserted strings verbatim in the update, so a byte scan works. */
function deltaText(doc: Y.Doc, sinceStateVector: Uint8Array): string {
  return new TextDecoder('latin1').decode(
    Y.encodeStateAsUpdate(doc, sinceStateVector)
  );
}

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  MarkdownCollabContentAdapter.seedFromFile(doc, ORIGINAL);
  return doc;
}

describe('applyMarkdownReplacementsToYDoc', () => {
  it('applies the replacement to the document', () => {
    const doc = seeded();

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'beta', newText: 'BETA' },
    ]);

    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('Paragraph two mentions BETA.');
    expect(result).toContain(UNTOUCHED);
  });

  it('does not rewrite paragraphs it did not touch', () => {
    const doc = seeded();
    const before = Y.encodeStateVector(doc);

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'beta', newText: 'BETA' },
    ]);

    expect(deltaText(doc, before)).not.toContain(UNTOUCHED);
  });

  /**
   * Control. `applyFromFile` is the codec's clear-and-reseed, the path this
   * design deliberately avoids for markdown. If it ever stops re-inserting the
   * untouched paragraph, the assertion above has stopped proving anything.
   */
  it('control: the codec clear-and-reseed DOES rewrite untouched paragraphs', () => {
    const doc = seeded();
    const before = Y.encodeStateVector(doc);

    MarkdownCollabContentAdapter.applyFromFile(
      doc,
      ORIGINAL.replace('beta', 'BETA')
    );

    expect(deltaText(doc, before)).toContain(UNTOUCHED);
  });

  /**
   * The node set is the whole ballgame for this path, and the fixture above
   * cannot catch a gap in it: plain paragraphs need almost no nodes registered.
   *
   * With `EditorNodes` (which omits list/link/image -- a mounted editor gets
   * those from the extension graph, and a standalone headless editor does NOT)
   * the binding threw "Node list is not registered", the editor state came up
   * EMPTY, and the edit then failed as `Old text "..." not found`. That message
   * blames the agent's quote for a document that never loaded, so the real
   * cause is invisible from the tool result.
   */
  it.each([
    ['a bullet list', '# Title\n\n- one\n- two\n\nParagraph mentions alpha.\n'],
    [
      'a link',
      '# Title\n\nSee [docs](https://example.com).\n\nParagraph mentions alpha.\n',
    ],
  ])('edits a document containing %s', (_label, markdown) => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(doc, markdown);

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'alpha', newText: 'ALPHA' },
    ]);

    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain('ALPHA');
  });

  it('throws rather than guessing when the text to replace is absent', () => {
    const doc = seeded();

    expect(() =>
      applyMarkdownReplacementsToYDoc(doc, [
        { oldText: 'text that was never in this document', newText: 'x' },
      ])
    ).toThrow();
    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(UNTOUCHED);
  });

  /**
   * The case above only exercises prose. A LIST-shaped `oldText` takes a
   * different branch: on a failed match the mounted editor reconstructs a
   * target markdown by locating the first list in the document and replacing
   * it, then reports success. Here that silently deleted the shipping blockers
   * -- a list the agent never referred to -- and acknowledged the write to
   * every collaborator.
   */
  it('does not rewrite a different list when a list-shaped match fails', () => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(
      doc,
      [
        '# Release checklist',
        '',
        '## Shipping blockers',
        '',
        '- audit the key rotation',
        '- verify the backup restore',
        '',
        '## Nice to have',
        '',
        '- tidy the settings icons',
        '- rename the export button',
        '',
      ].join('\n')
    );

    expect(() =>
      applyMarkdownReplacementsToYDoc(doc, [
        {
          // The "Nice to have" list, quoted imperfectly.
          oldText: '- tidy the settings icons\n- rename the export buttons',
          newText: '- tidy the settings icons',
        },
      ])
    ).toThrow();

    const after = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(after).toContain('audit the key rotation');
    expect(after).toContain('verify the backup restore');
  });
});

const COMMENT_QUOTE = 'mentions beta';
const COMMENT_THREAD = 'thread-before-headless-edit';
const DECISION = [
  '```decision',
  'id: dcn-headless-anchor',
  'ask: Approve the current layout?',
  'type: confirm',
  '```',
].join('\n');

/** Reopen the real Lexical/Yjs bridge each time: no retained editor can hide anchor loss. */
function withCommentEditor<T>(
  doc: Y.Doc,
  fn: (context: {
    headless: HeadlessLexicalYDoc;
    store: CommentStore;
    controller: ReturnType<typeof createCollabCommentController>;
  }) => T
): T {
  return withHeadlessLexicalBridge(
    doc,
    { nodes: HeadlessBodyNodes },
    (headless) => {
      const store = new CommentStore(headless.editor);
      const detach = store.registerCollaboration(
        new CommentCollabProvider(doc)
      );
      const controller = createCollabCommentController({
        commentStore: store,
        editor: headless.editor,
        currentUser: { id: 'reviewer', name: 'Reviewer' },
        documentUri: 'collab://org:anchor-proof:doc:headless',
        getCapabilities: () => ({ read: true, comment: true }),
        getMembers: () => [],
        isHydrated: () => true,
        isVisible: () => false,
      });
      try {
        return fn({ headless, store, controller });
      } finally {
        detach();
      }
    }
  );
}

function commentedDecisionDoc(): Y.Doc {
  const doc = new Y.Doc();
  MarkdownCollabContentAdapter.seedFromFile(doc, `${ORIGINAL}\n${DECISION}\n`);
  withCommentEditor(doc, ({ headless, store }) => {
    headless.applyUpdate(() => {
      const text = $getRoot()
        .getAllTextNodes()
        .find((node) => node.getTextContent().includes(COMMENT_QUOTE));
      if (!text) throw new Error('Comment fixture quote missing');
      const start = text.getTextContent().indexOf(COMMENT_QUOTE);
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), start, 'text');
      selection.focus.set(text.getKey(), start + COMMENT_QUOTE.length, 'text');
      $setSelection(selection);
      $wrapSelectionInMarkNode(selection, false, COMMENT_THREAD);
      $setSelection(null);
    });
    store.addComment(
      createThread(
        COMMENT_QUOTE,
        [createComment('Keep this constraint in the decision.', 'Reviewer')],
        COMMENT_THREAD
      )
    );
  });
  return doc;
}

function readCommentAttachment(doc: Y.Doc) {
  return withCommentEditor(doc, ({ controller, headless }) => ({
    threads: controller.list().threads,
    decisionTypes: headless.editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .filter((node) => node.getType() === 'decision')
        .map((node) => node.getType())
    ),
  }));
}

describe('headless edit comment attachment through the Lexical/Yjs bridge', () => {
  it('keeps the actual MarkNode thread attached through prose edits beside a decision, then fresh-client hydration', () => {
    const doc = commentedDecisionDoc();
    const initial = readCommentAttachment(doc);
    expect(initial.decisionTypes).toEqual(['decision']);
    expect(initial.threads).toMatchObject([
      {
        id: COMMENT_THREAD,
        quote: COMMENT_QUOTE,
        anchorState: 'attached',
        comments: [{ body: 'Keep this constraint in the decision.' }],
      },
    ]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(peer);
    try {
      applyMarkdownReplacementsToYDoc(doc, [
        {
          oldText: 'Paragraph two mentions beta.',
          newText: 'Revised paragraph two mentions beta.',
        },
      ]);
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Revised paragraph two mentions beta.'
      );
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Approve the current layout?'
      );
      expect(readCommentAttachment(doc)).toEqual(initial);
      // Only the emitted edit delta reaches the second client. This checks
      // serialized CRDT propagation and reopening, not server acknowledgement.
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, before));
      expect(readCommentAttachment(peer)).toEqual(initial);
      expect(MarkdownCollabContentAdapter.exportToFile(peer)).toContain(
        'Revised paragraph two mentions beta.'
      );
      withCommentEditor(peer, ({ headless }) =>
        headless.applyUpdate($approveDiffs)
      );
      expect(readCommentAttachment(peer)).toEqual(initial);
    } finally {
      doc.destroy();
      peer.destroy();
    }
  });

  it('applies a replacement inside a real decision fence without silently leaving the old question', () => {
    const doc = commentedDecisionDoc();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(peer);
    try {
      applyMarkdownReplacementsToYDoc(doc, [
        {
          oldText: DECISION,
          newText: DECISION.replace('current layout', 'revised layout'),
        },
      ]);
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Approve the revised layout?'
      );
      expect(readCommentAttachment(doc).threads[0].anchorState).toBe(
        'attached'
      );
      expect(readCommentAttachment(doc).decisionTypes).toEqual(['decision']);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, before));
      expect(MarkdownCollabContentAdapter.exportToFile(peer)).toContain(
        'Approve the revised layout?'
      );
      expect(readCommentAttachment(peer).threads).toEqual(
        readCommentAttachment(doc).threads
      );
      expect(readCommentAttachment(peer).decisionTypes).toEqual(['decision']);
    } finally {
      doc.destroy();
      peer.destroy();
    }
  });

  it.each(['approve all', 'reject all', 'approve group', 'reject group'])(
    'preserves one decision and its real comment when reopening to %s',
    (action) => {
      const doc = commentedDecisionDoc();
      try {
        applyMarkdownReplacementsToYDoc(doc, [
          {
            oldText: DECISION,
            newText: DECISION.replace('current layout', 'revised layout'),
          },
        ]);
        withCommentEditor(doc, ({ headless }) => {
          headless.editor.getEditorState().read(() => {
            const decisions = $getRoot()
              .getChildren()
              .filter((node) => node.getType() === 'decision');
            expect(decisions).toHaveLength(1);
            expect($getDiffState(decisions[0])).toBe('modified');
            expect($getOriginalMarkdown(decisions[0])).toContain(
              'Approve the current layout?'
            );
          });
          const groups = groupDiffChanges(headless.editor);
          expect(groups).toHaveLength(1);
          const nodes = groups[0].nodes;
          if (action === 'approve all') headless.applyUpdate($approveDiffs);
          else if (action === 'reject all') headless.applyUpdate($rejectDiffs);
          else if (action === 'approve group')
            $approveChangeGroup(headless.editor, nodes);
          else $rejectChangeGroup(headless.editor, nodes);
        });
        const question = action.startsWith('reject') ? 'current' : 'revised';
        expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
          `Approve the ${question} layout?`
        );
        expect(readCommentAttachment(doc).threads[0].anchorState).toBe(
          'attached'
        );
        withCommentEditor(doc, ({ headless }) =>
          headless.editor.getEditorState().read(() => {
            const decisions = $getRoot()
              .getChildren()
              .filter((node) => node.getType() === 'decision');
            expect(decisions).toHaveLength(1);
            expect($getDiffState(decisions[0])).toBeNull();
            expect($getOriginalMarkdown(decisions[0])).toBeNull();
          })
        );
      } finally {
        doc.destroy();
      }
    }
  );

  it('control: clear-and-reseed keeps thread data and its quote but orphans the real MarkNode anchor', () => {
    const doc = commentedDecisionDoc();
    const initial = readCommentAttachment(doc);
    expect(initial.threads[0].anchorState).toBe('attached');
    try {
      const markdown = MarkdownCollabContentAdapter.exportToFile(doc) as string;
      MarkdownCollabContentAdapter.applyFromFile(
        doc,
        markdown.replace('current layout', 'revised layout')
      );
      const after = readCommentAttachment(doc);
      expect(after.threads).toEqual(
        initial.threads.map((thread) => ({
          ...thread,
          anchorState: 'orphaned',
        }))
      );
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        COMMENT_QUOTE
      );
      expect(after.decisionTypes).toEqual(['decision']);
    } finally {
      doc.destroy();
    }
  });
});
