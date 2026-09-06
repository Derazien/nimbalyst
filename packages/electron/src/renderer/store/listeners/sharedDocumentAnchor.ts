import type { SharedDocumentAnchor } from '../../../shared/documentDeepLinks';

let stopPrevious: (() => void) | undefined;

/** Wait for the named document's editor, including an anchor hydrated later. */
export function focusSharedDocumentAnchor(documentUri: string, anchor: SharedDocumentAnchor): () => void {
  stopPrevious?.();
  if (!anchor.blockId && !anchor.threadId && !anchor.commentId) return () => {};
  let opened = false;
  let showingResolved = false;
  const match = (root: ParentNode, attribute: string, id: string | undefined) => id
    ? Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`)).find((element) => element.getAttribute(attribute) === id)
    : undefined;
  const observer = new MutationObserver(focus);
  const timer = setTimeout(stop, 30_000);
  function stop() { observer.disconnect(); clearTimeout(timer); }
  function focus() {
    const root = match(document, 'data-file-path', documentUri);
    if (!root) return;
    if (anchor.threadId || anchor.commentId) {
      const toggle = root.querySelector<HTMLElement>('[data-testid="comments-toggle"]');
      if (toggle && !opened) { opened = true; toggle.click(); }
    }
    const thread = match(root, 'data-thread-id', anchor.threadId);
    const target = anchor.commentId ? match(root, 'data-comment-id', anchor.commentId)
      : anchor.threadId ? thread : match(root, 'data-decision-id', anchor.blockId);
    if (target?.classList.contains('decision-container') && !target.querySelector('.decision-root')) return;
    if (!target) {
      const filter = root.querySelector<HTMLElement>('[data-testid="comments-panel-resolved-filter"][aria-pressed="false"]');
      if ((anchor.threadId || anchor.commentId) && filter && !showingResolved) { showingResolved = true; filter.click(); }
      return;
    }
    stop(); thread?.click();
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.scrollIntoView?.({ block: 'center' }); target.focus({ preventScroll: true });
  }
  observer.observe(document.body, { childList: true, subtree: true });
  stopPrevious = stop; focus(); return stop;
}
