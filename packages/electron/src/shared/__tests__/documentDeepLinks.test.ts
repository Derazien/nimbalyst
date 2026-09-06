// @vitest-environment node
import { expect, it } from 'vitest';
import { parseDocumentDeepLinkAnchor } from '../documentDeepLinks';

it('preserves exact opaque anchors after URL decoding, including surrounding spaces', () => {
  const anchors = { blockId: ' block/+%2F?#&=雪 ', threadId: ' thread+%20/é ', commentId: '  ' };
  const url = new URL(`nimbalyst://doc/document?${new URLSearchParams(anchors)}`);
  expect(parseDocumentDeepLinkAnchor(url)).toEqual(anchors);
});

it('rejects empty, overlong, and control-containing anchors without normalizing them into valid IDs', () => {
  for (const value of ['', 'x'.repeat(201), '\tquestion', 'question\n', '\u0000question', 'question\u007f']) {
    const url = new URL(`nimbalyst://doc/document?${new URLSearchParams({ blockId: value, threadId: 'valid' })}`);
    expect(parseDocumentDeepLinkAnchor(url)).toEqual({ threadId: 'valid' });
  }
  const blockId = ` ${'x'.repeat(198)} `;
  expect(parseDocumentDeepLinkAnchor(new URL(`nimbalyst://doc/document?${new URLSearchParams({ blockId })}`))).toEqual({ blockId });
});
