// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  LABEL_CLEARANCE,
  MIN_BOX_GAP,
  MIN_FRAME_GAP,
  MIN_PARENT_PADDING,
  reflowBoard,
  type BoardElement,
} from '../boardFit';

const box = (id: string, x: number, y: number, width: number, height: number, extra: Partial<BoardElement> = {}): BoardElement => ({
  id, type: 'rectangle', x, y, width, height, ...extra,
});

describe('reflowBoard', () => {
  it('pushes only the grown column down, keeps x, keeps larger gaps and moves a row together', () => {
    const elements = [
      box('a', 0, 0, 100, 50),
      box('d', 200, 0, 100, 50),
      box('b', 0, 70, 100, 50), // 20px under a: below the minimum gap
      box('e', 200, 70, 100, 50), // same row as b
      box('c', 0, 200, 100, 50), // 80px under b: a gap worth keeping
      box('f', 400, 500, 100, 50), // nothing above it
    ];
    const { rects } = reflowBoard({ elements, sizes: new Map([['a', { width: 100, height: 150 }]]) });

    const b = rects.get('b')!;
    expect(b.y).toBe(150 + MIN_BOX_GAP);
    expect(rects.get('e')!.y).toBe(b.y);
    expect(rects.get('c')!.y).toBe(b.y + 50 + 80);
    expect(rects.get('d')!.y).toBe(0);
    expect(rects.get('f')!.y).toBe(500);
    for (const el of elements) expect(rects.get(el.id)!.x).toBe(el.x);
  });

  it('makes room across for the label of an arrow between side-by-side boxes, and nowhere else', () => {
    const elements: BoardElement[] = [
      box('left', 0, 0, 100, 100),
      box('right', 120, 0, 100, 100),
      box('beyond', 240, 0, 100, 100),
      box('below', 0, 200, 340, 50),
      { id: 'arrow', type: 'arrow', x: 100, y: 50, width: 20, height: 0, startBinding: { elementId: 'left' }, endBinding: { elementId: 'right' } },
    ];
    const { rects } = reflowBoard({
      elements,
      sizes: new Map(),
      arrowLabelSizes: new Map([['arrow', { width: 90, height: 20 }]]),
    });

    const right = rects.get('right')!;
    expect(right.x).toBe(100 + 90 + LABEL_CLEARANCE * 2);
    expect(rects.get('beyond')!.x).toBe(right.x + 100 + 20);
    expect(rects.get('left')!.x).toBe(0);
    expect(rects.get('below')!.x).toBe(0);
  });

  it('grows a frame around pushed content, pushes the next frame, and leaves content inside a grouping box', () => {
    const elements = [
      box('frame-1', 0, 0, 300, 200, { type: 'frame' }),
      box('frame-2', 0, 240, 300, 100, { type: 'frame' }),
      box('a', 20, 20, 100, 50, { frameId: 'frame-1' }),
      box('b', 20, 90, 100, 50, { frameId: 'frame-1' }),
      box('group', 400, 0, 300, 300),
      box('inside', 420, 60, 100, 50),
    ];
    const { rects } = reflowBoard({
      elements,
      sizes: new Map([['a', { width: 100, height: 200 }]]),
      labelRects: new Map([['group', { x: 480, y: 10, width: 140, height: 25 }]]),
    });

    const frame1 = rects.get('frame-1')!;
    const b = rects.get('b')!;
    expect(b.y).toBe(20 + 200 + MIN_BOX_GAP);
    expect(frame1.y + frame1.height).toBeGreaterThanOrEqual(b.y + b.height + MIN_PARENT_PADDING);
    expect(rects.get('frame-2')!.y).toBeGreaterThanOrEqual(frame1.y + frame1.height + MIN_FRAME_GAP);
    expect(rects.get('inside')!.y).toBe(60);
    expect(rects.get('group')!.y).toBe(0);
  });
});
