// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { focusSharedDocumentAnchor } from '../sharedDocumentAnchor';
import { parseDocumentDeepLinkAnchor } from '../../../../shared/documentDeepLinks';

afterEach(() => { focusSharedDocumentAnchor('', {}); document.body.replaceChildren(); });
it('keeps block/comment/thread identities bounded while preserving valid exact destinations', () => {
  expect(parseDocumentDeepLinkAnchor(new URL('nimbalyst://doc/doc?blockId=q&threadId=t&commentId=c'))).toEqual({ blockId: 'q', threadId: 't', commentId: 'c' });
  expect(parseDocumentDeepLinkAnchor(new URL('nimbalyst://doc/doc?blockId=%00unsafe&threadId=t'))).toEqual({ threadId: 't' });
});
it('waits for the exact document and sealed decision instead of focusing a matching block in another tab', async () => {
  const wrong = document.createElement('div'); wrong.dataset.filePath = 'collab://org:org:doc:other';
  wrong.innerHTML = '<div data-decision-id="question">Other document</div>'; document.body.append(wrong);
  const stop = focusSharedDocumentAnchor('collab://org:org:doc:target', { blockId: 'question' });
  const target = document.createElement('div'); target.dataset.filePath = 'collab://org:org:doc:target';
  const decision = document.createElement('div'); decision.dataset.decisionId = 'question';
  decision.scrollIntoView = vi.fn(); target.append(decision); document.body.append(target);
  await vi.waitFor(() => expect(document.activeElement).toBe(decision));
  expect(decision.scrollIntoView).toHaveBeenCalledTimes(1); stop();
});
