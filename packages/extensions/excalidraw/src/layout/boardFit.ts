/**
 * Pure geometry for fitting a board after its boxes have grown to hold their
 * text: push overlapping boxes apart, grow frames and enclosing boxes around
 * their content, re-aim bound arrows, and keep arrow labels off each other.
 *
 * No Excalidraw imports: everything here takes plain numbers, so it is tested
 * without a browser. Measuring text is the caller's job (see utils/textFit).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  frameId?: string | null;
  groupIds?: readonly string[];
  containerId?: string | null;
  points?: readonly (readonly number[])[];
  startBinding?: { elementId: string; gap?: number } | null;
  endBinding?: { elementId: string; gap?: number } | null;
}

/** Vertical space kept between two stacked boxes. */
export const MIN_BOX_GAP = 24;
/** Vertical space kept between two stacked frames (the frame title sits in it). */
export const MIN_FRAME_GAP = 48;
/** Space kept between a frame (or enclosing box) edge and its content. */
export const MIN_PARENT_PADDING = 28;
/** Room kept above and below an arrow label that sits between two stacked boxes. */
export const LABEL_CLEARANCE = 16;
/** Shortest visible arrow between two stacked boxes. */
export const MIN_ARROW_GAP = 40;

const LAYOUT_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'text', 'frame', 'magicframe', 'embeddable', 'iframe']);
const PARENT_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame', 'magicframe']);
const ROW_EPSILON = 2;

function isFrameType(type: string): boolean {
  return type === 'frame' || type === 'magicframe';
}

function right(r: Rect): number {
  return r.x + r.width;
}

function bottom(r: Rect): number {
  return r.y + r.height;
}

function horizontallyOverlap(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a);
}

function contains(outer: Rect, inner: Rect): boolean {
  const tol = 1;
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    right(inner) <= right(outer) + tol &&
    bottom(inner) <= bottom(outer) + tol &&
    inner.width * inner.height < outer.width * outer.height
  );
}

/**
 * Is `inner` content drawn inside `outer` (a grouping box), rather than a
 * neighbour `outer` grew over? A real enclosing box keeps its own label clear
 * of what it holds; a box that grew onto a neighbour has its label on top of it.
 */
export function encloses(outer: Rect, inner: Rect, outerLabel?: Rect | null): boolean {
  if (!contains(outer, inner)) return false;
  return !(outerLabel && rectsOverlap(outerLabel, inner));
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < right(b) + margin &&
    b.x < right(a) + margin &&
    a.y < bottom(b) + margin &&
    b.y < bottom(a) + margin
  );
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Is element `a` a shape the layout moves (not bound text, not a line)? */
export function isLayoutElement(el: BoardElement): boolean {
  if (el.isDeleted) return false;
  if (!LAYOUT_TYPES.has(el.type)) return false;
  if (el.type === 'text' && el.containerId) return false;
  return true;
}

interface Unit {
  id: string;
  /** Element ids that move rigidly with this unit. */
  members: string[];
  isFrame: boolean;
  canParent: boolean;
  orig: Rect;
  size: { width: number; height: number };
  parent: string | null;
}

export interface ReflowInput {
  elements: readonly BoardElement[];
  /** Fitted sizes (grown to hold text); elements not listed keep their size. */
  sizes: ReadonlyMap<string, { width: number; height: number }>;
  /**
   * For each labeled arrow, the size of its label. Boxes joined by an arrow are
   * kept far enough apart for the arrow and its label, stacked or side by side.
   */
  arrowLabelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  /** Where each box's own label sits (at its original position, fitted size). */
  labelRects?: ReadonlyMap<string, Rect>;
}

export interface Offset {
  dx: number;
  dy: number;
}

export interface ReflowResult {
  /** Final rect of every layout element that was considered. */
  rects: Map<string, Rect>;
  /** Offset applied to every element id that moved (layout elements and frame members). */
  offsets: Map<string, Offset>;
}

function outermostGroup(el: BoardElement): string | null {
  const ids = el.groupIds;
  return ids && ids.length > 0 ? ids[ids.length - 1] : null;
}

function buildUnits(input: ReflowInput): { units: Map<string, Unit>; unitOfElement: Map<string, string> } {
  const units = new Map<string, Unit>();
  const unitOfElement = new Map<string, string>();
  const byGroup = new Map<string, BoardElement[]>();

  for (const el of input.elements) {
    if (!isLayoutElement(el)) continue;
    const group = isFrameType(el.type) ? null : outermostGroup(el);
    if (group) {
      const list = byGroup.get(group) ?? [];
      list.push(el);
      byGroup.set(group, list);
      continue;
    }
    const size = input.sizes.get(el.id) ?? { width: el.width, height: el.height };
    units.set(el.id, {
      id: el.id,
      members: [el.id],
      isFrame: isFrameType(el.type),
      canParent: PARENT_TYPES.has(el.type),
      orig: { x: el.x, y: el.y, width: el.width, height: el.height },
      size: { ...size },
      parent: null,
    });
    unitOfElement.set(el.id, el.id);
  }

  // A group moves as one rigid unit; its size is the box around its members
  // once each member has grown in place.
  for (const [group, members] of byGroup) {
    const id = `group:${group}`;
    const orig = boundingRect(members.map((m) => ({ x: m.x, y: m.y, width: m.width, height: m.height })));
    const grown = boundingRect(
      members.map((m) => {
        const size = input.sizes.get(m.id) ?? { width: m.width, height: m.height };
        return { x: m.x, y: m.y, width: size.width, height: size.height };
      }),
    );
    units.set(id, {
      id,
      members: members.map((m) => m.id),
      isFrame: false,
      canParent: false,
      orig,
      size: { width: right(grown) - orig.x, height: bottom(grown) - orig.y },
      parent: null,
    });
    for (const m of members) unitOfElement.set(m.id, id);
  }

  // Parent: the element's frame, else the smallest box that encloses it.
  const elementById = new Map(input.elements.map((el) => [el.id, el]));
  for (const unit of units.values()) {
    if (unit.isFrame) continue;
    const first = elementById.get(unit.members[0]);
    const frameId = first?.frameId ?? null;
    if (frameId && units.get(frameId)?.isFrame) {
      unit.parent = frameId;
      continue;
    }
    let best: Unit | null = null;
    for (const candidate of units.values()) {
      if (candidate === unit || !candidate.canParent) continue;
      if (!encloses(candidate.orig, unit.orig, input.labelRects?.get(candidate.id))) continue;
      if (!best || candidate.orig.width * candidate.orig.height < best.orig.width * best.orig.height) {
        best = candidate;
      }
    }
    unit.parent = best ? best.id : null;
  }
  return { units, unitOfElement };
}

export function boundingRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map(right));
  const maxY = Math.max(...rects.map(bottom));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function depthOf(units: Map<string, Unit>, id: string): number {
  let depth = 0;
  let current = units.get(id)?.parent ?? null;
  while (current) {
    depth += 1;
    current = units.get(current)?.parent ?? null;
  }
  return depth;
}

/** The ancestor of `unitId` (or itself) that is a direct child of `parentId`. */
function ancestorUnder(units: Map<string, Unit>, unitId: string, parentId: string | null): string | null {
  let current: string | null = unitId;
  while (current) {
    const unit = units.get(current);
    if (!unit) return null;
    if (unit.parent === parentId) return current;
    current = unit.parent;
  }
  return null;
}

function verticallyOverlap(a: Rect, b: Rect): boolean {
  return a.y < bottom(b) && b.y < bottom(a);
}

/**
 * Push boxes apart until nothing overlaps, keeping every width and every
 * original gap. Boxes move down for boxes above them in the same columns (rows
 * sharing a top edge move together); they move right only to make room for the
 * label of an arrow joining them to a box beside them. Frames and enclosing
 * boxes grow to hold what they contain. Nothing ever moves up or left.
 */
export function reflowBoard(input: ReflowInput): ReflowResult {
  const { units, unitOfElement } = buildUnits(input);
  const shiftX = new Map<string, number>();
  const shiftY = new Map<string, number>();
  const sx = (unit: Unit) => shiftX.get(unit.id) ?? 0;

  // Arrow connections between units, with the label each one carries.
  const connections: Array<{ a: string; b: string; label: { width: number; height: number } | null }> = [];
  for (const el of input.elements) {
    if (el.isDeleted || el.type !== 'arrow') continue;
    const start = el.startBinding?.elementId;
    const end = el.endBinding?.elementId;
    if (!start || !end) continue;
    const a = unitOfElement.get(start);
    const b = unitOfElement.get(end);
    if (!a || !b || a === b) continue;
    connections.push({ a, b, label: input.arrowLabelSizes?.get(el.id) ?? null });
  }

  const childrenOf = new Map<string | null, Unit[]>();
  for (const unit of units.values()) {
    const list = childrenOf.get(unit.parent) ?? [];
    list.push(unit);
    childrenOf.set(unit.parent, list);
  }

  // Labels of the arrows joining each pair of siblings, per parent, computed
  // once so the passes below look pairs up instead of rescanning every arrow.
  const pairKey = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  const labelsByParent = new Map<string | null, Map<string, Array<{ width: number; height: number } | null>>>();
  const labelsBetween = (parentId: string | null, p: Unit, q: Unit) => {
    let byPair = labelsByParent.get(parentId);
    if (!byPair) {
      byPair = new Map();
      for (const c of connections) {
        const ua = ancestorUnder(units, c.a, parentId);
        const ub = ancestorUnder(units, c.b, parentId);
        if (!ua || !ub || ua === ub) continue;
        const key = pairKey(ua, ub);
        const list = byPair.get(key) ?? [];
        list.push(c.label);
        byPair.set(key, list);
      }
      labelsByParent.set(parentId, byPair);
    }
    return byPair.get(pairKey(p.id, q.id)) ?? [];
  };

  const verticalGap = (parentId: string | null, upper: Unit, lower: Unit): number => {
    let gap = upper.isFrame || lower.isFrame ? MIN_FRAME_GAP : MIN_BOX_GAP;
    for (const label of labelsBetween(parentId, upper, lower)) {
      gap = Math.max(gap, MIN_ARROW_GAP, label ? label.height + LABEL_CLEARANCE * 2 : 0);
    }
    return gap;
  };

  const horizontalGap = (parentId: string | null, leftUnit: Unit, rightUnit: Unit): number => {
    let gap = 0;
    for (const label of labelsBetween(parentId, leftUnit, rightUnit)) {
      gap = Math.max(gap, MIN_ARROW_GAP, label ? label.width + LABEL_CLEARANCE * 2 : 0);
    }
    return gap;
  };

  const reflowChildren = (parentId: string | null, children: Unit[]) => {
    const atX = (unit: Unit): Rect => ({ x: unit.orig.x + sx(unit), y: unit.orig.y, width: unit.size.width, height: unit.orig.height });
    const band = (unit: Unit): Rect => ({ x: unit.orig.x, y: unit.orig.y + (shiftY.get(unit.id) ?? 0), width: unit.orig.width, height: unit.size.height });

    // Down: rows in order; a row moves for anything above it in its columns.
    const moveDown = () => {
      const sorted = [...children].sort((a, b) => a.orig.y - b.orig.y || a.orig.x - b.orig.x);
      const rows: Unit[][] = [];
      for (const unit of sorted) {
        const row = rows[rows.length - 1];
        const sameRow =
          row &&
          Math.abs(unit.orig.y - row[0].orig.y) <= ROW_EPSILON &&
          !row.some((other) => horizontallyOverlap(atX(other), atX(unit)));
        if (sameRow) row.push(unit);
        else rows.push([unit]);
      }
      const placed: Array<{ unit: Unit; newBottom: number }> = [];
      for (const row of rows) {
        let shift = 0;
        for (const unit of row) {
          for (const p of placed) {
            if (!horizontallyOverlap(atX(p.unit), atX(unit))) continue;
            const originalGap = unit.orig.y - bottom(p.unit.orig);
            const needed = Math.max(verticalGap(parentId, p.unit, unit), originalGap);
            shift = Math.max(shift, p.newBottom + needed - unit.orig.y);
          }
        }
        for (const unit of row) {
          shiftY.set(unit.id, shift);
          placed.push({ unit, newBottom: unit.orig.y + shift + unit.size.height });
        }
      }
    };

    // Across: only an arrow label between boxes that end up side by side
    // forces room; whatever is right of them in the same band keeps its gap
    // and follows. Returns whether any box moved differently than last time.
    const moveAcross = (): boolean => {
      let changed = false;
      const byX = [...children].sort((a, b) => a.orig.x - b.orig.x || a.orig.y - b.orig.y);
      const next = new Map<string, number>();
      for (let i = 0; i < byX.length; i++) {
        const unit = byX[i];
        let shift = 0;
        for (let j = 0; j < i; j++) {
          const p = byX[j];
          if (right(p.orig) > unit.orig.x + ROW_EPSILON) continue;
          if (!verticallyOverlap(band(p), band(unit))) continue;
          const needed = Math.max(horizontalGap(parentId, p, unit), unit.orig.x - right(p.orig));
          shift = Math.max(shift, p.orig.x + (next.get(p.id) ?? 0) + p.size.width + needed - unit.orig.x);
        }
        next.set(unit.id, shift);
        if (Math.abs(shift - sx(unit)) > 0.01) changed = true;
      }
      for (const [id, shift] of next) shiftX.set(id, shift);
      return changed;
    };

    // Each pass can change what the other sees; settle in a few rounds.
    for (let round = 0; round < 4; round++) {
      moveDown();
      if (!moveAcross()) return;
    }
    moveDown();
  };

  // Innermost parents first: a parent's size depends on its laid-out content.
  const parents = [...childrenOf.keys()].filter((id): id is string => id !== null);
  parents.sort((a, b) => depthOf(units, b) - depthOf(units, a));
  for (const parentId of parents) {
    const parent = units.get(parentId);
    const children = childrenOf.get(parentId) ?? [];
    if (!parent || children.length === 0) continue;
    reflowChildren(parentId, children);

    const origContentBottom = Math.max(...children.map((c) => bottom(c.orig)));
    const origContentRight = Math.max(...children.map((c) => right(c.orig)));
    const contentBottom = Math.max(...children.map((c) => c.orig.y + (shiftY.get(c.id) ?? 0) + c.size.height));
    const contentRight = Math.max(...children.map((c) => c.orig.x + sx(c) + c.size.width));
    const bottomPad = Math.max(MIN_PARENT_PADDING, bottom(parent.orig) - origContentBottom);
    const rightPad = Math.max(MIN_PARENT_PADDING, right(parent.orig) - origContentRight);
    parent.size.height = Math.max(parent.size.height, contentBottom + bottomPad - parent.orig.y);
    parent.size.width = Math.max(parent.size.width, contentRight + rightPad - parent.orig.x);
  }
  reflowChildren(null, childrenOf.get(null) ?? []);

  // Absolute offsets, parents before children.
  const absolute = new Map<string, Offset>();
  const resolve = (id: string): Offset => {
    const cached = absolute.get(id);
    if (cached) return cached;
    const unit = units.get(id)!;
    const parent = unit.parent ? resolve(unit.parent) : { dx: 0, dy: 0 };
    const value = { dx: (shiftX.get(id) ?? 0) + parent.dx, dy: (shiftY.get(id) ?? 0) + parent.dy };
    absolute.set(id, value);
    return value;
  };

  const rects = new Map<string, Rect>();
  const offsets = new Map<string, Offset>();
  const elementById = new Map(input.elements.map((el) => [el.id, el]));
  for (const unit of units.values()) {
    const offset = resolve(unit.id);
    for (const memberId of unit.members) {
      const el = elementById.get(memberId)!;
      const size = unit.members.length === 1 ? unit.size : input.sizes.get(memberId) ?? { width: el.width, height: el.height };
      rects.set(memberId, { x: el.x + offset.dx, y: el.y + offset.dy, width: size.width, height: size.height });
      if (offset.dx !== 0 || offset.dy !== 0) offsets.set(memberId, offset);
    }
  }
  // Anything else inside a frame (lines, freedraw, unbound arrows) rides with it.
  for (const el of input.elements) {
    if (el.isDeleted || offsets.has(el.id) || rects.has(el.id)) continue;
    if (el.frameId && units.get(el.frameId)?.isFrame) {
      const offset = resolve(el.frameId);
      if (offset.dx !== 0 || offset.dy !== 0) offsets.set(el.id, offset);
    }
  }
  return { rects, offsets };
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export interface Shape extends Rect {
  type: string;
}

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

/** Where a ray from `origin` (inside the shape) along `dir` leaves the shape outline. */
export function shapeExit(shape: Shape, origin: Point, dir: Point): Point {
  const d = normalize(dir);
  const c = center(shape);
  if (shape.type === 'ellipse') {
    const a = shape.width / 2 || 1;
    const b = shape.height / 2 || 1;
    const ox = (origin.x - c.x) / a;
    const oy = (origin.y - c.y) / b;
    const dx = d.x / a;
    const dy = d.y / b;
    const qa = dx * dx + dy * dy;
    const qb = 2 * (ox * dx + oy * dy);
    const qc = ox * ox + oy * oy - 1;
    const disc = Math.max(0, qb * qb - 4 * qa * qc);
    const t = (-qb + Math.sqrt(disc)) / (2 * qa);
    return { x: origin.x + d.x * t, y: origin.y + d.y * t };
  }
  if (shape.type === 'diamond') {
    const corners = [
      { x: c.x, y: shape.y },
      { x: right(shape), y: c.y },
      { x: c.x, y: bottom(shape) },
      { x: shape.x, y: c.y },
    ];
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const q = corners[(i + 1) % 4];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const denom = d.x * ey - d.y * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((p.x - origin.x) * ey - (p.y - origin.y) * ex) / denom;
      const u = ((p.x - origin.x) * d.y - (p.y - origin.y) * d.x) / denom;
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    if (Number.isFinite(best)) return { x: origin.x + d.x * best, y: origin.y + d.y * best };
  }
  let t = Infinity;
  if (d.x > 0) t = Math.min(t, (right(shape) - origin.x) / d.x);
  else if (d.x < 0) t = Math.min(t, (shape.x - origin.x) / d.x);
  if (d.y > 0) t = Math.min(t, (bottom(shape) - origin.y) / d.y);
  else if (d.y < 0) t = Math.min(t, (shape.y - origin.y) / d.y);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { x: origin.x + d.x * t, y: origin.y + d.y * t };
}

export interface ArrowRouteOptions {
  gap?: number;
  /** Parallel offset from the center line, perpendicular to it. */
  shift?: number;
  /** Where the label sits along the arrow, 0 at the start, 1 at the end. */
  labelAt?: number;
  /** Bends the user or an earlier pass put in, in scene coordinates. */
  innerPoints?: readonly Point[];
}

export interface ArrowRoute {
  x: number;
  y: number;
  width: number;
  height: number;
  points: [number, number][];
}

/** Largest parallel offset that keeps an arrow's ends on both shapes. */
function maxShift(shapes: Shape[], normal: Point): number {
  return Math.min(
    ...shapes.map((s) => (Math.abs(normal.x) * s.width + Math.abs(normal.y) * s.height) / 2 * 0.8),
  );
}

/**
 * Aim an arrow at two shapes the way Excalidraw's bindings do: each end sits on
 * the shape outline plus `gap`, on the line toward the neighbouring point. A
 * shifted or slid arrow gets an explicit middle point, which keeps its offset
 * when Excalidraw later re-aims the ends at the shape centers.
 */
export function routeArrow(start: Shape, end: Shape, options: ArrowRouteOptions = {}): ArrowRoute {
  const gap = options.gap ?? 8;
  const cs = center(start);
  const ce = center(end);
  let absolute: Point[];

  if (options.innerPoints && options.innerPoints.length > 0) {
    const inner = options.innerPoints;
    const first = inner[0];
    const last = inner[inner.length - 1];
    const dirStart = normalize({ x: first.x - cs.x, y: first.y - cs.y });
    const dirEnd = normalize({ x: last.x - ce.x, y: last.y - ce.y });
    const p0 = shapeExit(start, cs, dirStart);
    const p1 = shapeExit(end, ce, dirEnd);
    absolute = [
      { x: p0.x + dirStart.x * gap, y: p0.y + dirStart.y * gap },
      ...inner,
      { x: p1.x + dirEnd.x * gap, y: p1.y + dirEnd.y * gap },
    ];
  } else {
    const dir = normalize({ x: ce.x - cs.x, y: ce.y - cs.y });
    const normal = { x: -dir.y, y: dir.x };
    const limit = maxShift([start, end], normal);
    const shift = Math.max(-limit, Math.min(limit, options.shift ?? 0));
    const os = { x: cs.x + normal.x * shift, y: cs.y + normal.y * shift };
    const oe = { x: ce.x + normal.x * shift, y: ce.y + normal.y * shift };
    const p0 = shapeExit(start, os, dir);
    const p1 = shapeExit(end, oe, { x: -dir.x, y: -dir.y });
    const a = { x: p0.x + dir.x * gap, y: p0.y + dir.y * gap };
    const b = { x: p1.x - dir.x * gap, y: p1.y - dir.y * gap };
    const t = options.labelAt ?? 0.5;
    if (shift !== 0 || Math.abs(t - 0.5) > 1e-6) {
      absolute = [a, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, b];
    } else {
      absolute = [a, b];
    }
  }

  const origin = absolute[0];
  const points = absolute.map((p) => [p.x - origin.x, p.y - origin.y] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: origin.x,
    y: origin.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
  };
}

/**
 * Where Excalidraw centers a bound arrow label: the middle point of an odd
 * point count, else the middle of the middle segment (straight segments).
 */
export function arrowLabelAnchor(route: { x: number; y: number; points: readonly (readonly number[])[] }): Point {
  const pts = route.points.map((p) => ({ x: route.x + p[0], y: route.y + p[1] }));
  if (pts.length === 0) return { x: route.x, y: route.y };
  if (pts.length % 2 === 1) return pts[(pts.length - 1) / 2];
  const a = pts[pts.length / 2 - 1];
  const b = pts[pts.length / 2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function labelRectAt(anchor: Point, size: { width: number; height: number }): Rect {
  return { x: anchor.x - size.width / 2, y: anchor.y - size.height / 2, width: size.width, height: size.height };
}

export interface ArrowPlan {
  id: string;
  start: Shape;
  end: Shape;
  startId: string;
  endId: string;
  gap?: number;
  label?: { width: number; height: number };
  /** Arrows the caller will not move (already on the board); their labels are obstacles. */
  fixed?: boolean;
  /** Current route of a fixed arrow, used for its label position. */
  route?: ArrowRoute;
}

export interface ArrowPlacement {
  shift: number;
  labelAt: number;
  route: ArrowRoute;
  labelRect: Rect | null;
}

const LABEL_MARGIN = 8;

/**
 * Route every movable arrow so that no two labels land on each other: arrows
 * that join the same two shapes are spread apart side by side, and a label that
 * would still collide slides along its arrow or moves the arrow sideways.
 * `obstacles` are shapes a label should avoid covering.
 */
export function placeArrows(plans: readonly ArrowPlan[], obstacles: ReadonlyMap<string, Rect>): Map<string, ArrowPlacement> {
  const result = new Map<string, ArrowPlacement>();
  const placedLabels: Rect[] = [];

  // Arrows joining the same pair of shapes start spread apart so their lines
  // and labels do not coincide.
  const pairKey = (p: ArrowPlan) => [p.startId, p.endId].sort().join('|');
  const byPair = new Map<string, ArrowPlan[]>();
  for (const plan of plans) {
    const list = byPair.get(pairKey(plan)) ?? [];
    list.push(plan);
    byPair.set(pairKey(plan), list);
  }
  const initialShift = new Map<string, number>();
  for (const siblings of byPair.values()) {
    if (siblings.length < 2) continue;
    const first = siblings[0];
    const dir = normalize({ x: center(first.end).x - center(first.start).x, y: center(first.end).y - center(first.start).y });
    const normal = { x: -dir.y, y: dir.x };
    const extent = Math.max(
      28,
      ...siblings.map((s) => (s.label ? Math.abs(normal.x) * s.label.width + Math.abs(normal.y) * s.label.height + LABEL_MARGIN : 0)),
    );
    // Offsets measured along the first sibling's normal. Arrows already on the
    // board hold the center line; new ones take the free slots beside it.
    const offsets: number[] = [];
    if (siblings.some((s) => s.fixed)) {
      const movable = siblings.filter((s) => !s.fixed).length;
      for (let k = 1; offsets.length < movable; k++) offsets.push(k * extent, -k * extent);
    } else {
      siblings.forEach((_, i) => offsets.push((i - (siblings.length - 1) / 2) * extent));
    }
    let next = 0;
    for (const s of siblings) {
      if (s.fixed) continue;
      const offset = offsets[next++] ?? 0;
      // A reverse arrow's own normal points the other way; flip so it lands on its slot.
      initialShift.set(s.id, s.startId === first.startId ? offset : -offset);
    }
  }

  for (const plan of plans) {
    if (!plan.fixed || !plan.route) continue;
    if (plan.label) placedLabels.push(labelRectAt(arrowLabelAnchor(plan.route), plan.label));
  }

  for (const plan of plans) {
    if (plan.fixed && plan.route) {
      const labelRect = plan.label ? labelRectAt(arrowLabelAnchor(plan.route), plan.label) : null;
      result.set(plan.id, { shift: 0, labelAt: 0.5, route: plan.route, labelRect });
      continue;
    }
    const base = initialShift.get(plan.id) ?? 0;
    const route0 = routeArrow(plan.start, plan.end, { gap: plan.gap, shift: base });
    if (!plan.label) {
      result.set(plan.id, { shift: base, labelAt: 0.5, route: route0, labelRect: null });
      continue;
    }
    const label = plan.label;
    const dir = normalize({ x: center(plan.end).x - center(plan.start).x, y: center(plan.end).y - center(plan.start).y });
    const normal = { x: -dir.y, y: dir.x };
    const acrossStep = Math.abs(normal.x) * label.width + Math.abs(normal.y) * label.height + LABEL_MARGIN;

    const candidates: Array<{ shift: number; labelAt: number }> = [{ shift: base, labelAt: 0.5 }];
    for (const t of [0.35, 0.65, 0.25, 0.75]) candidates.push({ shift: base, labelAt: t });
    for (const k of [1, -1, 2, -2, 3, -3]) candidates.push({ shift: base + k * acrossStep, labelAt: 0.5 });

    let best: ArrowPlacement | null = null;
    let bestCost = Infinity;
    for (const [index, candidate] of candidates.entries()) {
      const route = routeArrow(plan.start, plan.end, { gap: plan.gap, shift: candidate.shift, labelAt: candidate.labelAt });
      const rect = labelRectAt(arrowLabelAnchor(route), label);
      const padded = { x: rect.x - LABEL_MARGIN / 2, y: rect.y - LABEL_MARGIN / 2, width: rect.width + LABEL_MARGIN, height: rect.height + LABEL_MARGIN };
      let cost = index * 1e-3;
      for (const other of placedLabels) cost += overlapArea(padded, other) * 100;
      for (const [id, shape] of obstacles) {
        const weight = id === plan.startId || id === plan.endId ? 0.5 : 1;
        cost += overlapArea(rect, shape) * weight;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = { shift: candidate.shift, labelAt: candidate.labelAt, route, labelRect: rect };
      }
      if (cost < 1) break;
    }
    result.set(plan.id, best!);
    if (best?.labelRect) placedLabels.push(best.labelRect);
  }
  return result;
}
