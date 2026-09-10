/**
 * Repair a whole board so every label fits its box: the engine behind the
 * fit_to_text tool. Measures with the real font (utils/textFit), then hands the
 * grown sizes to the pure layout (layout/boardFit) and writes the results back
 * onto the existing elements, keeping their ids, styles and bindings.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  ARROW_LABEL_FONT_SIZE,
  boundTextPosition,
  ensureFontsReady,
  fitLabel,
  measureUnwrappedText,
  measureWrappedText,
  type LabelStyle,
  type MeasuredText,
} from './textFit';
import {
  arrowLabelAnchor,
  labelRectAt,
  placeArrows,
  reflowBoard,
  routeArrow,
  type ArrowPlan,
  type ArrowRoute,
  type Point,
  type Rect,
  type Shape,
} from '../layout/boardFit';

type AnyElement = ExcalidrawElement & Record<string, any>;

/** Return a copy with the updates applied and a new version, as Excalidraw's newElementWith does. */
export function withUpdates<T extends Record<string, any>>(element: T, updates: Record<string, unknown>): T {
  return {
    ...element,
    ...updates,
    version: (element.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

function styleOf(text: AnyElement): LabelStyle {
  return {
    fontSize: text.fontSize,
    fontFamily: text.fontFamily,
    lineHeight: text.lineHeight,
    textAlign: text.textAlign,
    verticalAlign: text.verticalAlign,
  };
}

/** Excalidraw's widest line for an arrow label (getBoundTextMaxWidth for arrows). */
export function arrowLabelLineWidth(arrowWidth: number, fontSize = ARROW_LABEL_FONT_SIZE): number {
  return Math.max(0.7 * arrowWidth, fontSize * 11);
}

function originalTextOf(text: AnyElement): string {
  return typeof text.originalText === 'string' && text.originalText.length > 0 ? text.originalText : String(text.text ?? '');
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

/**
 * A three-point arrow whose middle point sits on the line between its ends is
 * one this tool drew (a parallel offset or a slid label), not a bend a person
 * made, so it is planned again like any straight arrow.
 */
function isStraight(points: number[][]): boolean {
  if (points.length !== 3) return false;
  const [a, m, b] = points;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  const offLine = Math.abs(dx * (m[1] - a[1]) - dy * (m[0] - a[0])) / length;
  const along = ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / (length * length);
  return offLine < 1 && along > 0 && along < 1;
}

export interface FitBoardResult {
  elements: ExcalidrawElement[];
  /** Boxes that grew to hold their text. */
  resized: number;
  /** Shapes that moved to stop overlapping. */
  moved: number;
  /** Arrows re-aimed at their (moved or grown) shapes. */
  rerouted: number;
  /** False when the drawing font could not be confirmed loaded before measuring. */
  fontsReady: boolean;
}

export async function fitBoard(sceneElements: readonly ExcalidrawElement[]): Promise<FitBoardResult> {
  const live = (sceneElements as AnyElement[]).filter((el) => !el.isDeleted);
  const byId = new Map<string, AnyElement>(live.map((el) => [el.id, el]));
  const texts = live.filter((el) => el.type === 'text');

  const fontsReady = await ensureFontsReady(
    texts.map((t) => ({ text: originalTextOf(t), fontFamily: t.fontFamily })),
  );

  // 1. Measure every label and size every box around it.
  const sizes = new Map<string, { width: number; height: number }>();
  const measuredTexts = new Map<string, MeasuredText>();
  const labelRects = new Map<string, Rect>();
  const arrowLabels = new Map<string, AnyElement>();
  let resized = 0;
  for (const text of texts) {
    const original = originalTextOf(text);
    const container = text.containerId ? byId.get(text.containerId) : undefined;
    if (container && (container.type === 'arrow' || container.type === 'line')) {
      arrowLabels.set(container.id, text);
      continue;
    }
    if (container) {
      const fit = fitLabel(container.type, { width: container.width, height: container.height }, original, styleOf(text));
      sizes.set(container.id, { width: fit.width, height: fit.height });
      measuredTexts.set(text.id, fit.text);
      const pos = boundTextPosition(
        { type: container.type, x: container.x, y: container.y, width: fit.width, height: fit.height },
        { width: fit.text.width, height: fit.text.height, textAlign: text.textAlign, verticalAlign: text.verticalAlign },
      );
      labelRects.set(container.id, { x: pos.x, y: pos.y, width: fit.text.width, height: fit.text.height });
      if (fit.grew) resized += 1;
      continue;
    }
    if (text.containerId) continue; // bound to something that no longer exists
    const measured = text.autoResize === false
      ? measureWrappedText(original, text.width, styleOf(text))
      : measureUnwrappedText(original, styleOf(text));
    const width = text.autoResize === false ? text.width : measured.width;
    sizes.set(text.id, { width, height: measured.height });
    measuredTexts.set(text.id, measured);
  }

  const arrowLabelSizes = new Map<string, { width: number; height: number }>();
  for (const [arrowId, label] of arrowLabels) {
    const arrow = byId.get(arrowId)!;
    const measured = measureWrappedText(originalTextOf(label), arrowLabelLineWidth(arrow.width, label.fontSize), styleOf(label));
    arrowLabelSizes.set(arrowId, { width: measured.width, height: measured.height });
  }

  // 2. Push apart whatever now overlaps, and grow frames around their content.
  const { rects, offsets } = reflowBoard({ elements: live, sizes, arrowLabelSizes, labelRects });

  const updated = new Map<string, AnyElement>();
  const current = (id: string): AnyElement | undefined => updated.get(id) ?? byId.get(id);
  let moved = 0;
  for (const [id, rect] of rects) {
    const el = byId.get(id)!;
    const changes: Record<string, unknown> = {};
    if (!sameNumber(el.x, rect.x)) changes.x = rect.x;
    if (!sameNumber(el.y, rect.y)) changes.y = rect.y;
    if (!sameNumber(el.width, rect.width)) changes.width = rect.width;
    if (!sameNumber(el.height, rect.height)) changes.height = rect.height;
    const measured = el.type === 'text' ? measuredTexts.get(id) : undefined;
    if (measured && measured.text !== el.text) changes.text = measured.text;
    if (Object.keys(changes).length > 0) updated.set(id, withUpdates(el, changes));
    if (changes.x !== undefined || changes.y !== undefined) moved += 1;
  }

  // Bound text follows its (grown, moved) container, wrapped with padding.
  for (const text of texts) {
    const measured = measuredTexts.get(text.id);
    if (!measured || !text.containerId) continue;
    const container = current(text.containerId);
    if (!container) continue;
    const pos = boundTextPosition(container, {
      width: measured.width,
      height: measured.height,
      textAlign: text.textAlign,
      verticalAlign: text.verticalAlign,
    });
    const unchanged =
      measured.text === text.text &&
      sameNumber(measured.width, text.width) &&
      sameNumber(measured.height, text.height) &&
      sameNumber(pos.x, text.x) &&
      sameNumber(pos.y, text.y);
    if (unchanged) continue;
    updated.set(
      text.id,
      withUpdates(text, {
        text: measured.text,
        originalText: originalTextOf(text),
        width: measured.width,
        height: measured.height,
        lineHeight: measured.lineHeight,
        x: pos.x,
        y: pos.y,
      }),
    );
  }

  // Lines, drawings and loose arrows inside a frame ride along with it.
  for (const [id, offset] of offsets) {
    if (updated.has(id) || rects.has(id)) continue;
    const el = byId.get(id);
    if (!el || el.type === 'text') continue;
    if (el.type === 'arrow' && (el.startBinding || el.endBinding)) continue;
    updated.set(id, withUpdates(el, { x: el.x + offset.dx, y: el.y + offset.dy }));
  }

  // 3. Re-aim every arrow at its shapes and keep the labels off each other.
  const shapeOf = (id: string | undefined): Shape | null => {
    if (!id) return null;
    const el = current(id);
    if (!el || el.isDeleted) return null;
    return { type: el.type, x: el.x, y: el.y, width: el.width, height: el.height };
  };
  const plans: ArrowPlan[] = [];
  for (const arrow of live) {
    if (arrow.type !== 'arrow' || arrow.elbowed) continue;
    const startId = arrow.startBinding?.elementId as string | undefined;
    const endId = arrow.endBinding?.elementId as string | undefined;
    const start = shapeOf(startId);
    const end = shapeOf(endId);
    // A loop back to the same box has no straight route; leave it as drawn.
    if (!start || !end || !startId || !endId || startId === endId) continue;

    const label = arrowLabels.get(arrow.id);
    let labelSize: { width: number; height: number } | undefined;
    if (label) {
      const straight = routeArrow(start, end, { gap: arrow.startBinding?.gap ?? 8 });
      const measured = measureWrappedText(originalTextOf(label), arrowLabelLineWidth(straight.width, label.fontSize), styleOf(label));
      labelSize = { width: measured.width, height: measured.height };
    }

    const points = (arrow.points ?? []) as number[][];
    if (points.length > 2 && !isStraight(points)) {
      // A bend someone made: keep it (moved with its shapes) and only re-aim the ends.
      const a = offsets.get(startId) ?? { dx: 0, dy: 0 };
      const b = offsets.get(endId) ?? { dx: 0, dy: 0 };
      const dx = (a.dx + b.dx) / 2;
      const dy = (a.dy + b.dy) / 2;
      const inner: Point[] = points.slice(1, -1).map((p) => ({ x: arrow.x + p[0] + dx, y: arrow.y + p[1] + dy }));
      const route = routeArrow(start, end, { gap: arrow.startBinding?.gap ?? 8, innerPoints: inner });
      plans.push({ id: arrow.id, start, end, startId, endId, label: labelSize, fixed: true, route });
      continue;
    }
    plans.push({ id: arrow.id, start, end, startId, endId, gap: arrow.startBinding?.gap ?? 8, label: labelSize });
  }

  const obstacles = new Map<string, Rect>();
  for (const [id, rect] of rects) {
    const el = byId.get(id)!;
    if (el.type === 'frame' || el.type === 'magicframe') continue;
    obstacles.set(id, rect);
  }
  const placements = placeArrows(plans, obstacles);

  let rerouted = 0;
  for (const arrow of live) {
    const placement = placements.get(arrow.id);
    if (!placement) continue;
    const route: ArrowRoute = placement.route;
    const oldPoints = (arrow.points ?? []) as number[][];
    const samePath =
      sameNumber(route.x, arrow.x) &&
      sameNumber(route.y, arrow.y) &&
      route.points.length === oldPoints.length &&
      route.points.every((p, i) => sameNumber(p[0], oldPoints[i][0]) && sameNumber(p[1], oldPoints[i][1]));
    if (!samePath) {
      updated.set(
        arrow.id,
        withUpdates(arrow, {
          x: route.x,
          y: route.y,
          width: route.width,
          height: route.height,
          points: route.points,
        }),
      );
      rerouted += 1;
    }

    const label = arrowLabels.get(arrow.id);
    if (!label) continue;
    const measured = measureWrappedText(originalTextOf(label), arrowLabelLineWidth(route.width, label.fontSize), styleOf(label));
    const rect = labelRectAt(arrowLabelAnchor(route), measured);
    const labelUnchanged =
      measured.text === label.text &&
      sameNumber(measured.width, label.width) &&
      sameNumber(measured.height, label.height) &&
      sameNumber(rect.x, label.x) &&
      sameNumber(rect.y, label.y);
    if (labelUnchanged) continue;
    updated.set(
      label.id,
      withUpdates(label, {
        text: measured.text,
        originalText: originalTextOf(label),
        width: measured.width,
        height: measured.height,
        lineHeight: measured.lineHeight,
        x: rect.x,
        y: rect.y,
      }),
    );
  }

  // Labels on arrows the layout could not route (one end loose) still get the real font.
  for (const [arrowId, label] of arrowLabels) {
    if (placements.has(arrowId)) continue;
    const arrow = current(arrowId)!;
    const measured = measureWrappedText(originalTextOf(label), arrowLabelLineWidth(arrow.width, label.fontSize), styleOf(label));
    const rect = labelRectAt(arrowLabelAnchor(arrow as any), measured);
    updated.set(
      label.id,
      withUpdates(label, { text: measured.text, width: measured.width, height: measured.height, x: rect.x, y: rect.y }),
    );
  }

  return {
    elements: (sceneElements as AnyElement[]).map((el) => updated.get(el.id) ?? el) as ExcalidrawElement[],
    resized,
    moved,
    rerouted,
    fontsReady,
  };
}
