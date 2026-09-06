import {
  $createMarkNode,
  $isMarkNode,
  $wrapSelectionInMarkNode,
} from '@lexical/mark';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import { diffWords } from './diffWords';

interface MarkRange {
  start: number;
  end: number;
  ids: string[];
}

/** The same text coordinate system on both sides, including block boundaries. */
function $snapshot() {
  let text = '';
  const marks: MarkRange[] = [];
  const leaves: Array<{ start: number; end: number; node: TextNode }> = [];
  const visit = (node: LexicalNode) => {
    const start = text.length;
    if ($isTextNode(node)) {
      text += node.getTextContent();
      leaves.push({ start, end: text.length, node });
    } else if ($isElementNode(node)) {
      for (const child of node.getChildren()) visit(child);
      if ($isMarkNode(node))
        marks.push({ start, end: text.length, ids: node.getIDs() });
      if (!node.isInline()) text += '\n\n';
    } else {
      text += node.getTextContent();
    }
  };
  visit($getRoot());
  return { text, marks, leaves };
}

/**
 * Markdown cannot encode comment marks. Carry only wholly surviving ranges
 * into the comparison target, so approval does not strip unchanged anchors.
 * Offsets follow the actual edit; deleted/changed quotes are not guessed at a
 * different occurrence. The live document is never re-anchored by this helper.
 */
export function preserveCommentMarks(
  source: LexicalEditor,
  target: LexicalEditor
): void {
  const previous = source.getEditorState().read($snapshot);
  if (previous.marks.length === 0) return;
  const nextText = target.getEditorState().read(() => $snapshot().text);
  const equalRanges: Array<{
    start: number;
    end: number;
    targetStart: number;
  }> = [];
  let sourceOffset = 0;
  let targetOffset = 0;
  for (const segment of diffWords(previous.text, nextText)) {
    if (segment.type === 'equal') {
      equalRanges.push({
        start: sourceOffset,
        end: sourceOffset + segment.text.length,
        targetStart: targetOffset,
      });
    }
    if (segment.type !== 'insert') sourceOffset += segment.text.length;
    if (segment.type !== 'delete') targetOffset += segment.text.length;
  }
  target.update(
    () => {
      for (const mark of previous.marks) {
        if (mark.start === mark.end || mark.ids.length === 0) continue;
        const unchanged = equalRanges.find(
          (range) => range.start <= mark.start && range.end >= mark.end
        );
        if (!unchanged) continue;
        const start = unchanged.targetStart + mark.start - unchanged.start;
        const end = start + mark.end - mark.start;
        // Wrapping splits text nodes, so refresh keys before each next range.
        const { leaves } = $snapshot();
        const first = leaves.find(
          (leaf) => leaf.start <= start && leaf.end > start
        );
        const last = leaves.find((leaf) => leaf.start < end && leaf.end >= end);
        if (!first || !last) continue;
        const selection = $createRangeSelection();
        selection.anchor.set(first.node.getKey(), start - first.start, 'text');
        selection.focus.set(last.node.getKey(), end - last.start, 'text');
        $wrapSelectionInMarkNode(selection, false, mark.ids[0], (ids) =>
          $createMarkNode([...new Set([...ids, ...mark.ids])])
        );
      }
      $setSelection(null);
    },
    { discrete: true }
  );
}
