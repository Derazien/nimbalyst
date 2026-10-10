import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { VListHandle } from 'virtua';

/**
 * Scrolls the transcript to a tool card: jumps the virtual list to the row that
 * renders it, then aligns the card itself (a row can hold many tools). The card
 * is found by `data-transcript-tool-id`, retried while the row mounts.
 */
export function useRevealToolCard({ vlistRef, scrollContainerRef }: {
  vlistRef: RefObject<VListHandle | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const frameRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const reveal = useCallback((toolId: string, rowIndex: number) => {
    cancel();
    if (!vlistRef.current) return;
    vlistRef.current.scrollToIndex(rowIndex, { align: 'start' });
    let attempts = 0;
    const alignCard = () => {
      frameRef.current = null;
      const list = vlistRef.current;
      const container = scrollContainerRef.current;
      if (!list || !container) return;
      const card = Array.from(container.querySelectorAll<HTMLElement>('[data-transcript-tool-id]'))
        .find(element => element.dataset.transcriptToolId === toolId);
      if (card) {
        list.scrollBy(card.getBoundingClientRect().top - container.getBoundingClientRect().top - 8);
      } else if (++attempts < 6) {
        list.scrollToIndex(rowIndex, { align: 'start' });
        frameRef.current = requestAnimationFrame(alignCard);
      }
    };
    frameRef.current = requestAnimationFrame(alignCard);
  }, [cancel, scrollContainerRef, vlistRef]);

  useEffect(() => cancel, [cancel]);

  return reveal;
}
