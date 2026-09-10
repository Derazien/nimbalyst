/**
 * AI Tools for Excalidraw
 *
 * Provides Claude with tools to view and edit Excalidraw diagrams.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/**
 * Get the Excalidraw editor API from the tool context.
 * Uses the central EditorHost registry (context.editorAPI) populated by the bridge.
 */
function getEditorAPI(context: { editorAPI?: unknown }): ExcalidrawImperativeAPI | null {
  return (context.editorAPI as ExcalidrawImperativeAPI) ?? null;
}

/** Build a consistent error result when no editor API is available. */
function noEditorError(context: { activeFilePath?: string }): { success: false; error: string } {
  const path = context.activeFilePath;
  if (!path) {
    return {
      success: false,
      error: 'No Excalidraw file was provided. Pass filePath for an existing .excalidraw file; it does not need to be open.',
    };
  }
  return {
    success: false,
    error: `Could not connect to Excalidraw editor for ${path}. ` +
      'Nimbalyst could not initialize its hidden editor. Try again; if the file does not exist yet, create it first with the Write tool. ' +
      'Do not call extension_test_open_file as a prerequisite.',
  };
}
import { LayoutEngine } from './layout/LayoutEngine';
import { createFrame } from './utils/elementFactory';
import {
  ARROW_LABEL_FONT_SIZE,
  boundTextPosition,
  ensureFontsReady,
  fitLabel,
  measureUnwrappedText,
  measureWrappedText,
  type FittedLabel,
  type LabelStyle,
} from './utils/textFit';
import { arrowLabelLineWidth, fitBoard, withUpdates } from './utils/fitBoard';
import {
  arrowLabelAnchor,
  encloses,
  isLayoutElement,
  labelRectAt,
  placeArrows,
  rectsOverlap,
  routeArrow,
  type ArrowPlan,
  type ArrowRoute,
  type Rect,
  type Shape,
} from './layout/boardFit';

const FONT_NOT_READY_WARNING =
  'The drawing font had not finished loading, so text was measured with a fallback font and may not fit once it loads. Run fit_to_text on this file.';

const OVERLAP_HINT =
  'Some boxes grew to fit their text and now overlap other elements. Call fit_to_text once (after adding arrows) to push them apart.';

interface BoxSpec {
  label: string;
  x: number;
  y: number;
  fit: FittedLabel;
  backgroundColor: string;
  strokeColor: string;
  rounded: boolean;
}

interface CreatedBox {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Create labeled rectangles through Excalidraw, then apply our fit: the label
 * wrapped inside real padding and the box at the fitted size, with the text
 * placed where Excalidraw itself would place it.
 */
function createLabeledBoxes(specs: BoxSpec[]): { elements: any[]; boxes: CreatedBox[] } {
  const skeletons = specs.map((spec) => ({
    type: 'rectangle',
    x: spec.x,
    y: spec.y,
    width: spec.fit.width,
    height: spec.fit.height,
    backgroundColor: spec.backgroundColor,
    strokeColor: spec.strokeColor,
    roundness: spec.rounded ? { type: 3 } : null,
    label: { text: spec.label },
  }));
  const converted = convertToExcalidrawElements(skeletons as any[]) as any[];
  const rects = converted.filter((el) => el.type === 'rectangle');
  const boxes: CreatedBox[] = [];
  rects.forEach((rect, index) => {
    const spec = specs[index];
    if (!spec) return;
    rect.width = spec.fit.width;
    rect.height = spec.fit.height;
    const text = converted.find((el) => el.type === 'text' && el.containerId === rect.id);
    if (text) {
      const measured = spec.fit.text;
      text.text = measured.text;
      text.originalText = spec.label;
      text.width = measured.width;
      text.height = measured.height;
      text.lineHeight = measured.lineHeight;
      const pos = boundTextPosition(rect, { width: measured.width, height: measured.height, textAlign: text.textAlign, verticalAlign: text.verticalAlign });
      text.x = pos.x;
      text.y = pos.y;
    }
    boxes.push({ id: rect.id, label: spec.label, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  });
  return { elements: converted, boxes };
}

/** A short name for an element in tool results: its label, else its id. */
function describeRef(el: any, elements: readonly any[]): string {
  const bound = (el.boundElements || []).find((b: any) => b.type === 'text');
  const text = bound ? elements.find((e) => e.id === bound.id) : null;
  const label = text?.originalText || text?.text || el.name || (el.type === 'text' ? el.originalText || el.text : '');
  return label ? normalizeLabelText(String(label)).slice(0, 40) : el.id;
}

/**
 * Pairs of boxes that overlap, where at least one of them is in `ids`. A box
 * drawn inside another (a grouping background) is not an overlap.
 */
function findOverlaps(elements: readonly any[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const shapes = elements.filter((el) => isLayoutElement(el) && el.type !== 'frame' && el.type !== 'magicframe');
  const labelOf = (el: any): Rect | null => {
    const ref = (el.boundElements || []).find((b: any) => b.type === 'text');
    return (ref && elements.find((e) => e.id === ref.id)) || null;
  };
  const out: string[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      if (!wanted.has(a.id) && !wanted.has(b.id)) continue;
      if (!rectsOverlap(a, b)) continue;
      if (encloses(a, b, labelOf(a)) || encloses(b, a, labelOf(b))) continue;
      out.push(`${describeRef(a, elements)} / ${describeRef(b, elements)}`);
    }
  }
  return out;
}

function layoutReport(elements: readonly any[], ids: readonly string[], fontsReady: boolean): Record<string, unknown> {
  const report: Record<string, unknown> = {};
  const overlaps = findOverlaps(elements, ids);
  if (overlaps.length > 0) {
    report.overlaps = overlaps.slice(0, 20);
    report.hint = OVERLAP_HINT;
  }
  if (!fontsReady) report.warning = FONT_NOT_READY_WARNING;
  return report;
}

function textStyleOf(text: any): LabelStyle {
  return {
    fontSize: text.fontSize,
    fontFamily: text.fontFamily,
    lineHeight: text.lineHeight,
    textAlign: text.textAlign,
    verticalAlign: text.verticalAlign,
  };
}

function shapeOf(el: any): Shape {
  return { type: el.type, x: el.x, y: el.y, width: el.width || 0, height: el.height || 0 };
}

// Helper to normalize color names to Excalidraw palette
function normalizeColor(color?: string): string | undefined {
  if (!color) return undefined;
  const colorMap: Record<string, string> = {
    red: '#ffc9c9',
    green: '#b2f2bb',
    blue: '#a5d8ff',
    yellow: '#ffec99',
    orange: '#ffd8a8',
    purple: '#e599f7',
    pink: '#ffc0cb',
    gray: '#e9ecef',
    grey: '#e9ecef',
  };
  return colorMap[color.toLowerCase()] || color;
}

async function loadMermaidParser() {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  return parseMermaidToExcalidraw;
}

// Expose the same async test hook without eagerly loading Mermaid.
if (typeof window !== 'undefined') {
  (window as any).__excalidraw_parseMermaidToExcalidraw = async (
    mermaid: string,
    options?: Record<string, unknown>,
  ) => (await loadMermaidParser())(mermaid, options);
  (window as any).__excalidraw_convertToExcalidrawElements = convertToExcalidrawElements;
}

/**
 * Calculate the point on a rectangle's edge closest to a target point
 * Used to make arrows connect to element edges instead of centers
 */
function calculateEdgePoint(
  element: ExcalidrawElement,
  targetX: number,
  targetY: number,
  gap: number
): { x: number; y: number } {
  const centerX = element.x + (element.width || 0) / 2;
  const centerY = element.y + (element.height || 0) / 2;
  const halfWidth = (element.width || 0) / 2;
  const halfHeight = (element.height || 0) / 2;

  // Vector from center to target
  const dx = targetX - centerX;
  const dy = targetY - centerY;

  if (dx === 0 && dy === 0) {
    // Target is at center, default to right edge
    return { x: centerX + halfWidth + gap, y: centerY };
  }

  // Calculate intersection with rectangle edges
  // We need to find where the line from center to target intersects the rectangle
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let edgeX: number;
  let edgeY: number;

  // Determine which edge the line intersects
  if (absDx * halfHeight > absDy * halfWidth) {
    // Intersects left or right edge
    if (dx > 0) {
      // Right edge
      edgeX = centerX + halfWidth + gap;
      edgeY = centerY + (dy / dx) * halfWidth;
    } else {
      // Left edge
      edgeX = centerX - halfWidth - gap;
      edgeY = centerY - (dy / dx) * halfWidth;
    }
  } else {
    // Intersects top or bottom edge
    if (dy > 0) {
      // Bottom edge
      edgeY = centerY + halfHeight + gap;
      edgeX = centerX + (dx / dy) * halfHeight;
    } else {
      // Top edge
      edgeY = centerY - halfHeight - gap;
      edgeX = centerX - (dx / dy) * halfHeight;
    }
  }

  return { x: edgeX, y: edgeY };
}

/** Collapse whitespace so labels Excalidraw re-wrapped with newlines/trailing spaces still match. */
function normalizeLabelText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve an element reference to a scene element. Accepts an element id,
 * exact label text, or whitespace-normalized label text. Excalidraw stores
 * bound text re-wrapped to fit its container (inserting newlines and trailing
 * spaces), so exact text matching alone is fragile; `originalText` holds the
 * unwrapped label when available.
 */
function getElementByLabel(elements: readonly ExcalidrawElement[], ref: string): ExcalidrawElement | undefined {
  const byId = elements.find((el) => el.id === ref);
  if (byId) return byId;

  const exact = elements.find((el) => {
    if ('text' in el && el.text === ref) return true;
    if ('label' in el && (el as any).label?.text === ref) return true;
    return false;
  });
  if (exact) return exact;

  const want = normalizeLabelText(ref);
  if (!want) return undefined;
  return elements.find((el) => {
    const anyEl = el as any;
    if (typeof anyEl.originalText === 'string' && normalizeLabelText(anyEl.originalText) === want) return true;
    if ('text' in el && typeof anyEl.text === 'string' && normalizeLabelText(anyEl.text) === want) return true;
    if (typeof anyEl.label?.text === 'string' && normalizeLabelText(anyEl.label.text) === want) return true;
    return false;
  });
}

/**
 * Build a bound arrow (and its optional label text element) between two
 * containers. Goes through convertToExcalidrawElements so a `label` becomes a
 * properly measured text element bound to the arrow; the skeleton's explicit
 * `points` are preserved by the conversion. Bindings to the pre-existing
 * containers are patched on afterwards because the conversion can only bind
 * to elements passed in the same call. `route` (from placeArrows) can carry a
 * middle point that keeps the label clear of other labels.
 */
function createBoundArrow(
  fromContainer: ExcalidrawElement,
  toContainer: ExcalidrawElement,
  label?: string,
  route?: ArrowRoute
): { arrow: any; labelElements: any[] } {
  const gap = 8;
  let path = route;
  if (!path) {
    const fromCenterX = fromContainer.x + (fromContainer.width || 0) / 2;
    const fromCenterY = fromContainer.y + (fromContainer.height || 0) / 2;
    const toCenterX = toContainer.x + (toContainer.width || 0) / 2;
    const toCenterY = toContainer.y + (toContainer.height || 0) / 2;
    const fromEdge = calculateEdgePoint(fromContainer, toCenterX, toCenterY, gap);
    const toEdge = calculateEdgePoint(toContainer, fromCenterX, fromCenterY, gap);
    path = {
      x: fromEdge.x,
      y: fromEdge.y,
      width: toEdge.x - fromEdge.x,
      height: toEdge.y - fromEdge.y,
      points: [
        [0, 0],
        [toEdge.x - fromEdge.x, toEdge.y - fromEdge.y],
      ],
    };
  }
  const last = path.points[path.points.length - 1];

  const skeleton: any = {
    type: 'arrow',
    x: path.x,
    y: path.y,
    width: last[0],
    height: last[1],
    points: path.points.map((p) => [p[0], p[1]]),
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    endArrowhead: 'arrow',
  };
  if (label) {
    skeleton.label = { text: label, fontSize: ARROW_LABEL_FONT_SIZE };
  }

  const converted = convertToExcalidrawElements([skeleton]);
  const convArrow = converted.find((el) => el.type === 'arrow') ?? converted[0];
  const labelElements = converted.filter((el) => el !== convArrow);

  const arrow = {
    ...convArrow,
    startBinding: { elementId: fromContainer.id, focus: 0, gap },
    endBinding: { elementId: toContainer.id, focus: 0, gap },
  };
  return { arrow, labelElements };
}

/** The bound container an arrow endpoint reference resolves to. */
function resolveArrowEnd(elements: readonly ExcalidrawElement[], ref: string): ExcalidrawElement | undefined {
  const el = getElementByLabel(elements, ref);
  if (!el) return undefined;
  if ('containerId' in el && el.containerId) {
    return elements.find((candidate) => candidate.id === el.containerId) || el;
  }
  return el;
}

/**
 * Add arrows between existing elements. Labels are measured in the loaded
 * font and routed so they do not land on labels already on the board, or on
 * each other: arrows joining the same two boxes are spread side by side.
 */
async function addArrowsToScene(
  api: ExcalidrawImperativeAPI,
  defs: Array<{ from: string; to: string; label?: string }>
): Promise<{ ids: string[]; errors: string[]; fontsReady: boolean }> {
  const currentElements = api.getSceneElements() as readonly any[];
  const byId = new Map(currentElements.map((el) => [el.id, el]));
  const fontsReady = await ensureFontsReady(
    defs.filter((d) => d.label).map((d) => ({ text: d.label as string }))
  );

  const errors: string[] = [];
  const resolved: Array<{ index: number; from: any; to: any; label?: string }> = [];
  defs.forEach((def, index) => {
    const from = resolveArrowEnd(currentElements, def.from);
    const to = resolveArrowEnd(currentElements, def.to);
    if (!from || !to) {
      errors.push(`Could not find elements: ${!from ? def.from : ''} ${!to ? def.to : ''}`);
      return;
    }
    resolved.push({ index, from, to, label: def.label });
  });

  // Arrows already on the board keep their route; their labels are obstacles.
  const plans: ArrowPlan[] = [];
  for (const el of currentElements) {
    if (el.type !== 'arrow' || el.isDeleted) continue;
    const labelRef = (el.boundElements || []).find((b: any) => b.type === 'text');
    const labelEl = labelRef ? byId.get(labelRef.id) : undefined;
    const startEl = el.startBinding?.elementId ? byId.get(el.startBinding.elementId) : undefined;
    const endEl = el.endBinding?.elementId ? byId.get(el.endBinding.elementId) : undefined;
    const pointShape = { type: 'rectangle', x: el.x, y: el.y, width: 0, height: 0 };
    plans.push({
      id: el.id,
      fixed: true,
      route: { x: el.x, y: el.y, width: el.width, height: el.height, points: el.points ?? [] },
      start: startEl ? shapeOf(startEl) : pointShape,
      end: endEl ? shapeOf(endEl) : pointShape,
      startId: startEl ? startEl.id : `${el.id}:start`,
      endId: endEl ? endEl.id : `${el.id}:end`,
      label: labelEl ? { width: labelEl.width, height: labelEl.height } : undefined,
    });
  }
  for (const r of resolved) {
    let label: { width: number; height: number } | undefined;
    if (r.label) {
      const straight = routeArrow(shapeOf(r.from), shapeOf(r.to));
      const measured = measureWrappedText(r.label, arrowLabelLineWidth(straight.width), { fontSize: ARROW_LABEL_FONT_SIZE });
      label = { width: measured.width, height: measured.height };
    }
    plans.push({
      id: `new:${r.index}`,
      start: shapeOf(r.from),
      end: shapeOf(r.to),
      startId: r.from.id,
      endId: r.to.id,
      gap: 8,
      label,
    });
  }

  const obstacles = new Map<string, Rect>();
  for (const el of currentElements) {
    if (!isLayoutElement(el) || el.type === 'frame' || el.type === 'magicframe') continue;
    obstacles.set(el.id, shapeOf(el));
  }
  const placements = placeArrows(plans, obstacles);

  const newArrows: any[] = [];
  const elementUpdates = new Map<string, any>();
  const ids: string[] = [];
  for (const r of resolved) {
    const placement = placements.get(`new:${r.index}`);
    const { arrow, labelElements } = createBoundArrow(r.from, r.to, r.label, placement?.route);
    newArrows.push(arrow, ...labelElements);
    ids.push(arrow.id);
    for (const containerId of [r.from.id, r.to.id]) {
      if (!elementUpdates.has(containerId)) {
        const el = byId.get(containerId);
        if (el) {
          elementUpdates.set(containerId, withUpdates(el, { boundElements: [...(el.boundElements || [])] }));
        }
      }
      elementUpdates.get(containerId)?.boundElements.push({ id: arrow.id, type: 'arrow' });
    }
  }

  const updatedElements = currentElements.map((el) => (elementUpdates.has(el.id) ? elementUpdates.get(el.id) : el));
  api.updateScene({ elements: [...updatedElements, ...newArrows] });
  return { ids, errors, fontsReady };
}

/**
 * AI tool definitions (exported as array)
 */
export const aiTools = [
  {
    name: 'get_elements',
    scope: 'global' as const,
    access: { kind: 'editor-read' } as const,
    description: 'Get list of diagram elements with labels and group membership. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (_params: Record<string, never>, context: { activeFilePath?: string; editorAPI?: unknown }) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const sceneElements = api.getSceneElements();

      // Extract labeled elements
      const elements = sceneElements
        .filter((el) => {
          if ('text' in el && el.text) return true;
          if ('label' in el && (el as any).label?.text) return true;
          return false;
        })
        .map((el) => {
          const label = ('text' in el && el.text) || ('label' in el && (el as any).label?.text) || '';

          return {
            id: el.id,
            type: el.type,
            label,
          };
        });

      return {
        success: true,
        data: { elements },
      };
    },
  },

  {
    name: 'add_rectangle',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add a labeled rectangle to the diagram. Rectangles are rounded by default. Use x,y for explicit positioning, or nearElement for relative placement. The label wraps inside the box with padding; the box keeps its width and grows taller (never shorter) until the label fits, and the result returns the final width and height. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string' as const,
          description: 'Text label for the rectangle',
        },
        x: {
          type: 'number' as const,
          description: 'X position (left edge). If not provided, auto-positions.',
        },
        y: {
          type: 'number' as const,
          description: 'Y position (top edge). If not provided, auto-positions.',
        },
        width: {
          type: 'number' as const,
          description: 'Width of the rectangle (default: 150)',
        },
        height: {
          type: 'number' as const,
          description: 'Minimum height of the rectangle (default: 80). It grows taller if its label needs more room.',
        },
        nearElement: {
          type: 'string' as const,
          description: 'Optional element label to place near (ignored if x,y provided)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color. PREFER Excalidraw default palette for best visual consistency: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple), #ffc0cb (pink). When user says "red", use #ffc9c9 not #ff0000.',
        },
        strokeColor: {
          type: 'string' as const,
          description: 'Border color (hex code or color name)',
        },
        rounded: {
          type: 'boolean' as const,
          description: 'Whether to use rounded corners (default: true)',
        },
      },
      required: ['label'],
    },
    handler: async (
      params: {
        label: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        nearElement?: string;
        color?: string;
        strokeColor?: string;
        rounded?: boolean;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const { label, nearElement, color, strokeColor, rounded = true } = params;
      const currentElements = api.getSceneElements() || [];

      // Measure in the real font, then size the box around the padded label.
      const fontsReady = await ensureFontsReady([{ text: label }]);
      const fit = fitLabel('rectangle', { width: params.width || 150, height: params.height || 80 }, label);

      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      let position: { x: number; y: number };

      // Use explicit coordinates if provided
      if (params.x !== undefined && params.y !== undefined) {
        position = { x: params.x, y: params.y };
      } else if (nearElement) {
        const nearEl = getElementByLabel(currentElements, nearElement);
        if (nearEl) {
          position = engine.calculateNearPosition(nearEl.id, fit.width, fit.height);
        } else {
          position = engine.calculateDefaultPosition(fit.width, fit.height);
        }
      } else {
        position = engine.calculateDefaultPosition(fit.width, fit.height);
      }

      const { elements: newElements, boxes } = createLabeledBoxes([
        {
          label,
          x: position.x,
          y: position.y,
          fit,
          backgroundColor: normalizeColor(color) || 'transparent',
          strokeColor: normalizeColor(strokeColor) || '#1e1e1e',
          rounded,
        },
      ]);

      const nextElements = [...currentElements, ...newElements];
      api.updateScene({ elements: nextElements });

      const box = boxes[0];
      return {
        success: true,
        data: {
          id: box?.id,
          x: position.x,
          y: position.y,
          width: box?.width,
          height: box?.height,
          ...layoutReport(nextElements, box ? [box.id] : [], fontsReady),
        },
      };
    },
  },

  {
    name: 'add_arrow',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add an arrow connecting two elements. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string' as const,
          description: 'Label or element id of the source element',
        },
        to: {
          type: 'string' as const,
          description: 'Label or element id of the target element',
        },
        label: {
          type: 'string' as const,
          description: 'Optional label for the arrow',
        },
      },
      required: ['from', 'to'],
    },
    handler: async (
      params: {
        from: string;
        to: string;
        label?: string;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const { ids, errors, fontsReady } = await addArrowsToScene(api, [
        { from: params.from, to: params.to, label: params.label },
      ]);
      if (ids.length === 0) {
        return { success: false, error: errors[0] ?? 'Could not add the arrow' };
      }
      return {
        success: true,
        data: { id: ids[0], ...(fontsReady ? {} : { warning: FONT_NOT_READY_WARNING }) },
      };
    },
  },

  {
    name: 'update_element',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Update text, color, or style of existing element. Can look up by ID or label. A new label is re-wrapped with padding and its box grows taller if it needs to. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string' as const,
          description: 'Element ID to update (use this if you have the ID from get_elements)',
        },
        label: {
          type: 'string' as const,
          description: 'Current label of the element to update (alternative to id)',
        },
        newLabel: {
          type: 'string' as const,
          description: 'New label text',
        },
        color: {
          type: 'string' as const,
          description: 'New fill color (hex code or color name)',
        },
        strokeColor: {
          type: 'string' as const,
          description: 'New border color (hex code or color name)',
        },
      },
    },
    handler: async (
      params: {
        id?: string;
        label?: string;
        newLabel?: string;
        color?: string;
        strokeColor?: string;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (!params.id && !params.label) {
        return {
          success: false,
          error: 'Must provide either id or label',
        };
      }

      const currentElements = api.getSceneElements();

      // Find element by ID or label
      let textElement: ExcalidrawElement | undefined;
      if (params.id) {
        textElement = currentElements.find(el => el.id === params.id);
      } else if (params.label) {
        textElement = getElementByLabel(currentElements, params.label);
      }

      if (!textElement) {
        return {
          success: false,
          error: `Element not found: ${params.label}`,
        };
      }

      // Helper to normalize colors to Excalidraw palette
      const normalizeColor = (color?: string): string | undefined => {
        if (!color) return undefined;
        const colorMap: Record<string, string> = {
          red: '#ffc9c9', green: '#b2f2bb', blue: '#a5d8ff', yellow: '#ffec99',
          orange: '#ffd8a8', purple: '#e599f7', pink: '#ffc0cb', gray: '#e9ecef', grey: '#e9ecef',
        };
        return colorMap[color.toLowerCase()] || color;
      };

      // A container reference edits the label bound to it.
      if (!('text' in textElement)) {
        const boundRef = ((textElement as any).boundElements || []).find((b: any) => b.type === 'text');
        const bound = boundRef ? currentElements.find((el) => el.id === boundRef.id) : undefined;
        if (bound) textElement = bound;
      }
      const target = textElement as any;

      // Find the container (rectangle) if this is a text element bound to one
      let containerElement: any;
      if (target.containerId) {
        containerElement = currentElements.find(el => el.id === target.containerId);
      }

      const textUpdates: Record<string, unknown> = {};
      const containerUpdates: Record<string, unknown> = {};
      let fontsReady = true;
      if (params.newLabel !== undefined && target.type === 'text') {
        // Re-wrap the new label in the real font and let its box grow to hold it.
        const newLabel = params.newLabel;
        fontsReady = await ensureFontsReady([{ text: newLabel, fontFamily: target.fontFamily }]);
        const style = textStyleOf(target);
        let measured;
        let box = containerElement;
        if (containerElement && containerElement.type !== 'arrow' && containerElement.type !== 'line') {
          const fit = fitLabel(containerElement.type, { width: containerElement.width, height: containerElement.height }, newLabel, style);
          measured = fit.text;
          if (fit.width !== containerElement.width) containerUpdates.width = fit.width;
          if (fit.height !== containerElement.height) containerUpdates.height = fit.height;
          box = { ...containerElement, ...containerUpdates };
          const pos = boundTextPosition(box, { width: measured.width, height: measured.height, textAlign: target.textAlign, verticalAlign: target.verticalAlign });
          Object.assign(textUpdates, { x: pos.x, y: pos.y });
        } else if (containerElement) {
          measured = measureWrappedText(newLabel, arrowLabelLineWidth(containerElement.width, target.fontSize), style);
          const rect = labelRectAt(arrowLabelAnchor(containerElement), measured);
          Object.assign(textUpdates, { x: rect.x, y: rect.y });
        } else {
          measured = target.autoResize === false
            ? measureWrappedText(newLabel, target.width, style)
            : measureUnwrappedText(newLabel, style);
        }
        Object.assign(textUpdates, {
          text: measured.text,
          originalText: newLabel,
          width: target.autoResize === false && !containerElement ? target.width : measured.width,
          height: measured.height,
          lineHeight: measured.lineHeight,
        });
      }

      // Prepare updates for container (for color changes)
      const colorTarget = containerElement ?? (target.type === 'text' ? undefined : target);
      if (params.color !== undefined) {
        containerUpdates.backgroundColor = normalizeColor(params.color);
      }
      if (params.strokeColor !== undefined) {
        containerUpdates.strokeColor = normalizeColor(params.strokeColor);
      }

      // Apply updates. Versions are bumped so a hidden editor saves the edit.
      const updatedElements = currentElements.map((el) => {
        if (el.id === target.id && Object.keys(textUpdates).length > 0) {
          return withUpdates(el as any, textUpdates);
        }
        if (colorTarget && el.id === colorTarget.id && Object.keys(containerUpdates).length > 0) {
          return withUpdates(el as any, containerUpdates);
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      const grown = containerUpdates.height !== undefined || containerUpdates.width !== undefined;
      return {
        success: true,
        ...(grown || !fontsReady
          ? { data: layoutReport(updatedElements, colorTarget ? [colorTarget.id] : [], fontsReady) }
          : {}),
      };
    },
  },

  {
    name: 'remove_element',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Remove an element by ID or label. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string' as const,
          description: 'Element ID to remove (use this if you have the ID from get_elements)',
        },
        label: {
          type: 'string' as const,
          description: 'Label of the element to remove (alternative to id)',
        },
      },
    },
    handler: async (
      params: { id?: string; label?: string },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (!params.id && !params.label) {
        return {
          success: false,
          error: 'Must provide either id or label',
        };
      }

      const currentElements = api.getSceneElements();

      // Find element by ID or label
      let element: ExcalidrawElement | undefined;
      if (params.id) {
        element = currentElements.find(el => el.id === params.id);
      } else if (params.label) {
        element = getElementByLabel(currentElements, params.label);
      }

      if (!element) {
        return {
          success: false,
          error: `Element not found`,
        };
      }

      // Remove both the element and its container (if it's a text element)
      let idsToRemove = [element.id];
      if ('containerId' in element && element.containerId) {
        idsToRemove.push(element.containerId as string);
      }

      const updatedElements = currentElements.filter((el) => !idsToRemove.includes(el.id));

      api.updateScene({ elements: updatedElements });

      return { success: true };
    },
  },

  // TODO: The relayout tool does a terrible job - it scatters elements randomly
  // instead of creating a clean layout. Needs proper graph layout algorithm implementation.
  // Commenting out until fixed.
  // {
  //   name: 'relayout',
  //   description: 'Re-run layout engine on entire diagram',
  //   parameters: {
  //     type: 'object' as const,
  //     properties: {
  //       algorithm: {
  //         type: 'string' as const,
  //         enum: ['hierarchical', 'force-directed', 'grid'],
  //         description: 'Layout algorithm to use',
  //       },
  //       direction: {
  //         type: 'string' as const,
  //         enum: ['TB', 'LR', 'BT', 'RL'],
  //         description: 'Direction for hierarchical layout',
  //       },
  //     },
  //   },
  //   handler: async (
  //     params: {
  //       algorithm?: string;
  //       direction?: string;
  //     },
  //     context: { activeFilePath?: string; editorAPI?: unknown }
  //   ) => {
  //     const api = getEditorAPI(context);
  //     if (!api) {
  //       return {
  //         success: false,
  //         error: 'No active Excalidraw editor found.',
  //       };
  //     }
  //
  //     const algorithm = (params.algorithm || 'hierarchical') as 'hierarchical' | 'force-directed' | 'grid';
  //     const direction = (params.direction || 'TB') as 'TB' | 'LR' | 'BT' | 'RL';
  //
  //     const currentElements = api.getSceneElements();
  //     const engine = new LayoutEngine();
  //     engine.addElements(currentElements);
  //
  //     const positions = engine.layout({
  //       algorithm,
  //       direction,
  //     });
  //
  //     const updatedElements = currentElements.map((el) => {
  //       const pos = positions.get(el.id);
  //       return pos ? { ...el, x: pos.x, y: pos.y } : el;
  //     });
  //
  //     api.updateScene({ elements: updatedElements });
  //
  //     return { success: true };
  //   },
  // },

  {
    name: 'import_mermaid',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Import a Mermaid diagram into Excalidraw. Use this to create complex architecture diagrams, flowcharts, and system designs. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        mermaid: {
          type: 'string' as const,
          description: 'Mermaid diagram syntax (e.g., "graph TD; A-->B; B-->C")',
        },
      },
      required: ['mermaid'],
    },
    handler: async (
      params: { mermaid: string },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      try {
        const parseMermaidToExcalidraw = await loadMermaidParser();
        const { elements, files } = await parseMermaidToExcalidraw(params.mermaid, {
          themeVariables: { fontSize: '16px' },
        });

        // Mermaid `<br/>` line breaks survive into skeleton label text as
        // literal "<br>" strings. Rewrite them to newlines BEFORE conversion
        // so text measurement accounts for the extra lines.
        const rewriteBrTags = (text: string) => text.replace(/<br\s*\/?>/gi, '\n');
        const sanitizedSkeletons = (elements as any[]).map((el) => {
          const out = { ...el };
          if (typeof out.text === 'string') out.text = rewriteBrTags(out.text);
          if (typeof out.label?.text === 'string') out.label = { ...out.label, text: rewriteBrTags(out.label.text) };
          return out;
        });

        // Convert skeleton elements to proper Excalidraw elements
        const excalidrawElements = convertToExcalidrawElements(sanitizedSkeletons);

        console.log('[import_mermaid] Got', elements.length, 'skeleton elements');
        console.log('[import_mermaid] Converted to', excalidrawElements.length, 'excalidraw elements');

        const currentElements = api.getSceneElements();
        console.log('[import_mermaid] Current scene has', currentElements.length, 'elements');

        // Add converted elements to the scene
        const newElements = [...currentElements, ...excalidrawElements];
        console.log('[import_mermaid] Updating scene with', newElements.length, 'total elements');

        // Register the image blob(s) Mermaid produced before adding the elements
        // that reference them. The rendered diagram is an image element whose
        // data lives in `files`; updateScene does not accept files, so without
        // addFiles the fileId resolves to nothing and the element renders as a
        // broken thumbnail (#428). Natively-converted diagrams return
        // `files: undefined` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Object.values(undefined) throws.
        // mermaid-to-excalidraw ships types for a newer excalidraw than the
        // 0.17.6 this extension pins, so cast at the boundary.
        const importedFiles = files ? (Object.values(files) as BinaryFileData[]) : [];
        if (importedFiles.length > 0) {
          api.addFiles(importedFiles);
        }

        api.updateScene({
          elements: newElements,
        });

        console.log('[import_mermaid] After updateScene, scene has', api.getSceneElements().length, 'elements');

        // mermaid-to-excalidraw renders diagram types it cannot convert
        // natively as a single rasterized image element. Surface that so the
        // caller knows the result is not editable shapes.
        const isImageFallback = excalidrawElements.length > 0 &&
          excalidrawElements.every((el: any) => el.type === 'image');
        return {
          success: true,
          message: isImageFallback
            ? `Imported Mermaid diagram as a non-editable image (this diagram type is not supported for native shape conversion): ${importedFiles.length} image file(s) embedded`
            : `Imported Mermaid diagram: ${elements.length} skeleton ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ${excalidrawElements.length} elements`
        };
      } catch (error) {
        console.error('[import_mermaid] failed:', error);
        return {
          success: false,
          error: `Failed to import Mermaid: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  {
    name: 'clear_all',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Remove all elements from the diagram. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      _params: Record<string, never>,
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      api.updateScene({ elements: [] });

      return {
        success: true,
        message: 'Cleared all elements from the diagram'
      };
    },
  },

  {
    name: 'add_frame',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add a frame (container with title) to group related elements. Frames have a title bar and can contain other elements. Use this to create visual sections like "Browser", "Services", "Database" in architecture diagrams. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string' as const,
          description: 'Title/name for the frame (appears at top)',
        },
        x: {
          type: 'number' as const,
          description: 'X position (left edge)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position (top edge)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of the frame (default: 400)',
        },
        height: {
          type: 'number' as const,
          description: 'Height of the frame (default: 300)',
        },
      },
      required: ['name'],
    },
    handler: async (
      params: {
        name: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 400;
      const height = params.height || 300;

      let x = params.x;
      let y = params.y;

      // If no position specified, find a good default position
      if (x === undefined || y === undefined) {
        const pos = engine.calculateDefaultPosition(width, height);
        x = x ?? pos.x;
        y = y ?? pos.y;
      }

      const frame = createFrame({
        x,
        y,
        width,
        height,
        name: params.name,
      });

      api.updateScene({
        elements: [...currentElements, frame],
      });

      return { success: true, data: { id: frame.id, x, y, width, height } };
    },
  },

  {
    name: 'add_row',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add multiple labeled rectangles arranged horizontally in a row. Great for creating groups of related items side by side. Every box in the row gets the height of the tallest label once wrapped. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels for each rectangle in the row',
        },
        x: {
          type: 'number' as const,
          description: 'X position of the first element (default: auto-positioned)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position of the row (default: auto-positioned)',
        },
        spacing: {
          type: 'number' as const,
          description: 'Space between elements (default: 20)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color for all rectangles. PREFER Excalidraw palette: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of each rectangle (default: 120)',
        },
        height: {
          type: 'number' as const,
          description: 'Minimum height of each rectangle (default: 60). Boxes grow taller if their labels need more room.',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
        x?: number;
        y?: number;
        spacing?: number;
        color?: string;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 120;
      const height = params.height || 60;
      const spacing = params.spacing || 20;

      // Every box in a row shares the height of the tallest fitted label.
      const fontsReady = await ensureFontsReady(params.labels.map((text) => ({ text })));
      const fits = params.labels.map((label) => fitLabel('rectangle', { width, height }, label));
      const rowHeight = Math.max(height, ...fits.map((f) => f.height));
      const widths = fits.map((f) => f.width);

      // Calculate starting position
      let startX = params.x;
      let startY = params.y;

      if (startX === undefined || startY === undefined) {
        const totalWidth = widths.reduce((sum, w) => sum + w, 0) + (params.labels.length - 1) * spacing;
        const pos = engine.calculateDefaultPosition(totalWidth, rowHeight);
        startX = startX ?? pos.x;
        startY = startY ?? pos.y;
      }

      let cursorX = startX!;
      const specs: BoxSpec[] = params.labels.map((label, index) => {
        const spec: BoxSpec = {
          label,
          x: cursorX,
          y: startY!,
          fit: { ...fits[index], height: rowHeight },
          backgroundColor: normalizeColor(params.color) || 'transparent',
          strokeColor: '#1e1e1e',
          rounded: true,
        };
        cursorX += widths[index] + spacing;
        return spec;
      });

      const { elements: newElements, boxes } = createLabeledBoxes(specs);
      const nextElements = [...currentElements, ...newElements];
      api.updateScene({ elements: nextElements });

      const ids = boxes.map((b) => b.id);
      return {
        success: true,
        data: {
          ids,
          count: params.labels.length,
          width: widths[0],
          height: rowHeight,
          ...layoutReport(nextElements, ids, fontsReady),
        },
      };
    },
  },

  {
    name: 'add_column',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add multiple labeled rectangles arranged vertically in a column. Great for creating stacked items or lists. Boxes grow to fit their labels and stack by their real heights. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels for each rectangle in the column',
        },
        x: {
          type: 'number' as const,
          description: 'X position of the column (default: auto-positioned)',
        },
        y: {
          type: 'number' as const,
          description: 'Y position of the first element (default: auto-positioned)',
        },
        spacing: {
          type: 'number' as const,
          description: 'Space between elements (default: 20)',
        },
        color: {
          type: 'string' as const,
          description: 'Fill color for all rectangles. PREFER Excalidraw palette: #ffc9c9 (red), #b2f2bb (green), #a5d8ff (blue), #ffec99 (yellow), #ffd8a8 (orange), #e599f7 (purple)',
        },
        width: {
          type: 'number' as const,
          description: 'Width of each rectangle (default: 120)',
        },
        height: {
          type: 'number' as const,
          description: 'Minimum height of each rectangle (default: 60). Boxes grow taller if their labels need more room.',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
        x?: number;
        y?: number;
        spacing?: number;
        color?: string;
        width?: number;
        height?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const width = params.width || 120;
      const height = params.height || 60;
      const spacing = params.spacing || 20;

      // Each box is stacked below the real (grown) height of the one above it.
      const fontsReady = await ensureFontsReady(params.labels.map((text) => ({ text })));
      const fits = params.labels.map((label) => fitLabel('rectangle', { width, height }, label));
      const columnWidth = Math.max(width, ...fits.map((f) => f.width));
      const heights = fits.map((f) => f.height);

      // Calculate starting position
      let startX = params.x;
      let startY = params.y;

      if (startX === undefined || startY === undefined) {
        const totalHeight = heights.reduce((sum, h) => sum + h, 0) + (params.labels.length - 1) * spacing;
        const pos = engine.calculateDefaultPosition(columnWidth, totalHeight);
        startX = startX ?? pos.x;
        startY = startY ?? pos.y;
      }

      let cursorY = startY!;
      const specs: BoxSpec[] = params.labels.map((label, index) => {
        const spec: BoxSpec = {
          label,
          x: startX!,
          y: cursorY,
          fit: { ...fits[index], width: columnWidth },
          backgroundColor: normalizeColor(params.color) || 'transparent',
          strokeColor: '#1e1e1e',
          rounded: true,
        };
        cursorY += heights[index] + spacing;
        return spec;
      });

      const { elements: newElements, boxes } = createLabeledBoxes(specs);
      const nextElements = [...currentElements, ...newElements];
      api.updateScene({ elements: nextElements });

      const ids = boxes.map((b) => b.id);
      return {
        success: true,
        data: {
          ids,
          count: params.labels.length,
          elements: boxes.map((b) => ({ id: b.id, label: b.label, y: b.y, height: b.height })),
          ...layoutReport(nextElements, ids, fontsReady),
        },
      };
    },
  },

  {
    name: 'align_elements',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Align multiple elements by their labels. Use this to make elements line up neatly. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to align',
        },
        alignment: {
          type: 'string' as const,
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'],
          description: 'How to align the elements',
        },
      },
      required: ['labels', 'alignment'],
    },
    handler: async (
      params: {
        labels: string[];
        alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find elements by label
      const elementsToAlign: ExcalidrawElement[] = [];
      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          // If it's a text element with a container, get the container
          if ('containerId' in el && el.containerId) {
            const container = currentElements.find(e => e.id === el.containerId);
            if (container) {
              elementsToAlign.push(container);
            }
          } else {
            elementsToAlign.push(el);
          }
        }
      }

      if (elementsToAlign.length < 2) {
        return {
          success: false,
          error: `Need at least 2 elements to align. Found ${elementsToAlign.length}.`,
        };
      }

      // Calculate alignment reference point
      let referenceValue: number;

      switch (params.alignment) {
        case 'left':
          referenceValue = Math.min(...elementsToAlign.map(el => el.x));
          break;
        case 'center':
          const minX = Math.min(...elementsToAlign.map(el => el.x));
          const maxX = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
          referenceValue = (minX + maxX) / 2;
          break;
        case 'right':
          referenceValue = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
          break;
        case 'top':
          referenceValue = Math.min(...elementsToAlign.map(el => el.y));
          break;
        case 'middle':
          const minY = Math.min(...elementsToAlign.map(el => el.y));
          const maxY = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
          referenceValue = (minY + maxY) / 2;
          break;
        case 'bottom':
          referenceValue = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
          break;
      }

      // Calculate position updates
      const updates = new Map<string, { x?: number; y?: number }>();

      for (const el of elementsToAlign) {
        let newPos: { x?: number; y?: number } = {};

        switch (params.alignment) {
          case 'left':
            newPos.x = referenceValue;
            break;
          case 'center':
            newPos.x = referenceValue - (el.width || 0) / 2;
            break;
          case 'right':
            newPos.x = referenceValue - (el.width || 0);
            break;
          case 'top':
            newPos.y = referenceValue;
            break;
          case 'middle':
            newPos.y = referenceValue - (el.height || 0) / 2;
            break;
          case 'bottom':
            newPos.y = referenceValue - (el.height || 0);
            break;
        }

        updates.set(el.id, newPos);

        // Also update bound text elements
        const boundElements = (el as any).boundElements || [];
        for (const bound of boundElements) {
          if (bound.type === 'text') {
            const textEl = currentElements.find(e => e.id === bound.id);
            if (textEl) {
              const dx = (newPos.x !== undefined) ? newPos.x - el.x : 0;
              const dy = (newPos.y !== undefined) ? newPos.y - el.y : 0;
              updates.set(bound.id, {
                x: textEl.x + dx,
                y: textEl.y + dy,
              });
            }
          }
        }
      }

      // Apply updates. Versions are bumped so a hidden editor saves the edit.
      const updatedElements = currentElements.map((el) => {
        const update = updates.get(el.id);
        if (update) {
          return withUpdates(el as any, {
            ...(update.x !== undefined ? { x: update.x } : {}),
            ...(update.y !== undefined ? { y: update.y } : {}),
          });
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { alignedCount: elementsToAlign.length } };
    },
  },

  {
    name: 'distribute_elements',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Distribute elements evenly with equal spacing between them. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to distribute',
        },
        direction: {
          type: 'string' as const,
          enum: ['horizontal', 'vertical'],
          description: 'Direction to distribute elements',
        },
        spacing: {
          type: 'number' as const,
          description: 'Optional fixed spacing between elements. If not provided, distributes evenly within current bounds.',
        },
      },
      required: ['labels', 'direction'],
    },
    handler: async (
      params: {
        labels: string[];
        direction: 'horizontal' | 'vertical';
        spacing?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find elements by label
      const elementsToDistribute: ExcalidrawElement[] = [];
      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          // If it's a text element with a container, get the container
          if ('containerId' in el && el.containerId) {
            const container = currentElements.find(e => e.id === el.containerId);
            if (container) {
              elementsToDistribute.push(container);
            }
          } else {
            elementsToDistribute.push(el);
          }
        }
      }

      if (elementsToDistribute.length < 3) {
        return {
          success: false,
          error: `Need at least 3 elements to distribute. Found ${elementsToDistribute.length}.`,
        };
      }

      // Sort elements by position
      if (params.direction === 'horizontal') {
        elementsToDistribute.sort((a, b) => a.x - b.x);
      } else {
        elementsToDistribute.sort((a, b) => a.y - b.y);
      }

      // Calculate distribution
      const updates = new Map<string, { x?: number; y?: number }>();

      if (params.direction === 'horizontal') {
        const firstEl = elementsToDistribute[0];
        const lastEl = elementsToDistribute[elementsToDistribute.length - 1];

        if (params.spacing !== undefined) {
          // Fixed spacing
          let currentX = firstEl.x;
          for (const el of elementsToDistribute) {
            updates.set(el.id, { x: currentX });
            currentX += (el.width || 0) + params.spacing;
          }
        } else {
          // Even distribution within bounds
          const startX = firstEl.x;
          const endX = lastEl.x;
          const totalWidth = endX - startX;
          const step = totalWidth / (elementsToDistribute.length - 1);

          elementsToDistribute.forEach((el, index) => {
            updates.set(el.id, { x: startX + index * step });
          });
        }
      } else {
        const firstEl = elementsToDistribute[0];
        const lastEl = elementsToDistribute[elementsToDistribute.length - 1];

        if (params.spacing !== undefined) {
          // Fixed spacing
          let currentY = firstEl.y;
          for (const el of elementsToDistribute) {
            updates.set(el.id, { y: currentY });
            currentY += (el.height || 0) + params.spacing;
          }
        } else {
          // Even distribution within bounds
          const startY = firstEl.y;
          const endY = lastEl.y;
          const totalHeight = endY - startY;
          const step = totalHeight / (elementsToDistribute.length - 1);

          elementsToDistribute.forEach((el, index) => {
            updates.set(el.id, { y: startY + index * step });
          });
        }
      }

      // Also move bound text elements
      for (const el of elementsToDistribute) {
        const boundElements = (el as any).boundElements || [];
        const elUpdate = updates.get(el.id);
        if (elUpdate) {
          for (const bound of boundElements) {
            if (bound.type === 'text') {
              const textEl = currentElements.find(e => e.id === bound.id);
              if (textEl) {
                const dx = elUpdate.x !== undefined ? elUpdate.x - el.x : 0;
                const dy = elUpdate.y !== undefined ? elUpdate.y - el.y : 0;
                updates.set(bound.id, {
                  x: textEl.x + dx,
                  y: textEl.y + dy,
                });
              }
            }
          }
        }
      }

      // Apply updates. Versions are bumped so a hidden editor saves the edit.
      const updatedElements = currentElements.map((el) => {
        const update = updates.get(el.id);
        if (update) {
          return withUpdates(el as any, {
            ...(update.x !== undefined ? { x: update.x } : {}),
            ...(update.y !== undefined ? { y: update.y } : {}),
          });
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { distributedCount: elementsToDistribute.length } };
    },
  },

  {
    name: 'move_element',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Move an element to specific coordinates or by a relative offset. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string' as const,
          description: 'Label of the element to move',
        },
        x: {
          type: 'number' as const,
          description: 'New X position (absolute)',
        },
        y: {
          type: 'number' as const,
          description: 'New Y position (absolute)',
        },
        dx: {
          type: 'number' as const,
          description: 'Relative X offset (use instead of x for relative movement)',
        },
        dy: {
          type: 'number' as const,
          description: 'Relative Y offset (use instead of y for relative movement)',
        },
      },
      required: ['label'],
    },
    handler: async (
      params: {
        label: string;
        x?: number;
        y?: number;
        dx?: number;
        dy?: number;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (params.x === undefined && params.y === undefined && params.dx === undefined && params.dy === undefined) {
        return {
          success: false,
          error: 'Must provide x/y coordinates or dx/dy offsets',
        };
      }

      const currentElements = api.getSceneElements();
      const element = getElementByLabel(currentElements, params.label);

      if (!element) {
        return {
          success: false,
          error: `Element not found: ${params.label}`,
        };
      }

      // Get the container if this is a text element
      let targetElement = element;
      if ('containerId' in element && element.containerId) {
        const container = currentElements.find(e => e.id === element.containerId);
        if (container) {
          targetElement = container;
        }
      }

      // Calculate new position
      let newX = targetElement.x;
      let newY = targetElement.y;

      if (params.x !== undefined) newX = params.x;
      if (params.y !== undefined) newY = params.y;
      if (params.dx !== undefined) newX = targetElement.x + params.dx;
      if (params.dy !== undefined) newY = targetElement.y + params.dy;

      const dx = newX - targetElement.x;
      const dy = newY - targetElement.y;

      // Build list of elements to move (container + bound text)
      const idsToMove = new Set([targetElement.id]);
      const boundElements = (targetElement as any).boundElements || [];
      for (const bound of boundElements) {
        if (bound.type === 'text') {
          idsToMove.add(bound.id);
        }
      }

      // Apply updates. Versions are bumped so a hidden editor saves the edit.
      const updatedElements = currentElements.map((el) => {
        if (idsToMove.has(el.id)) {
          return withUpdates(el as any, { x: el.x + dx, y: el.y + dy });
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { newX, newY } };
    },
  },

  {
    name: 'group_elements',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Group multiple elements together so they move as a unit. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to group together',
        },
      },
      required: ['labels'],
    },
    handler: async (
      params: {
        labels: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if (params.labels.length < 2) {
        return {
          success: false,
          error: 'Need at least 2 elements to group',
        };
      }

      const currentElements = api.getSceneElements();
      const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Find all element IDs to group (including containers and bound text)
      const idsToGroup = new Set<string>();

      for (const label of params.labels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          idsToGroup.add(el.id);

          // If text with container, also add container
          if ('containerId' in el && el.containerId) {
            idsToGroup.add(el.containerId as string);
          }

          // If container with bound text, also add text
          const boundElements = (el as any).boundElements || [];
          for (const bound of boundElements) {
            idsToGroup.add(bound.id);
          }
        }
      }

      // Apply group ID to all elements
      const updatedElements = currentElements.map((el) => {
        if (idsToGroup.has(el.id)) {
          const existingGroups = (el as any).groupIds || [];
          return withUpdates(el as any, { groupIds: [...existingGroups, groupId] });
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { groupId, elementCount: idsToGroup.size } };
    },
  },

  {
    name: 'set_elements_in_frame',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Move elements into a frame so they become children of that frame. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        frameLabel: {
          type: 'string' as const,
          description: 'Name/label of the frame',
        },
        elementLabels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to put in the frame',
        },
      },
      required: ['frameLabel', 'elementLabels'],
    },
    handler: async (
      params: {
        frameLabel: string;
        elementLabels: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements();

      // Find frame by name
      const frame = currentElements.find(
        el => el.type === 'frame' && (el as any).name === params.frameLabel
      );

      if (!frame) {
        return {
          success: false,
          error: `Frame not found: ${params.frameLabel}`,
        };
      }

      // Find all element IDs to add to frame
      const idsToAddToFrame = new Set<string>();

      for (const label of params.elementLabels) {
        const el = getElementByLabel(currentElements, label);
        if (el) {
          idsToAddToFrame.add(el.id);

          // If text with container, also add container
          if ('containerId' in el && el.containerId) {
            idsToAddToFrame.add(el.containerId as string);
          }

          // If container with bound text, also add text
          const boundElements = (el as any).boundElements || [];
          for (const bound of boundElements) {
            idsToAddToFrame.add(bound.id);
          }
        }
      }

      // Set frameId on all elements
      const updatedElements = currentElements.map((el) => {
        if (idsToAddToFrame.has(el.id)) {
          return withUpdates(el as any, { frameId: frame.id });
        }
        return el;
      });

      api.updateScene({ elements: updatedElements });

      return { success: true, data: { frameId: frame.id, elementCount: idsToAddToFrame.size } };
    },
  },

  {
    name: 'add_arrows',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add multiple arrows in a single batch operation. Much more efficient than calling add_arrow repeatedly when creating diagrams with many connections. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        arrows: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              from: {
                type: 'string' as const,
                description: 'Label or element id of the source element',
              },
              to: {
                type: 'string' as const,
                description: 'Label or element id of the target element',
              },
              label: {
                type: 'string' as const,
                description: 'Optional label for the arrow',
              },
            },
            required: ['from', 'to'],
          },
          description: 'Array of arrow definitions to create',
        },
      },
      required: ['arrows'],
    },
    handler: async (
      params: {
        arrows: Array<{ from: string; to: string; label?: string }>;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const { ids, errors, fontsReady } = await addArrowsToScene(api, params.arrows);

      return {
        success: true,
        data: {
          created: ids.length,
          ids,
          errors: errors.length > 0 ? errors : undefined,
          ...(fontsReady ? {} : { warning: FONT_NOT_READY_WARNING }),
        },
      };
    },
  },

  {
    name: 'add_elements',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Add multiple rectangles in a single batch operation. Much more efficient than calling add_rectangle repeatedly when creating diagrams with many elements. Labels wrap inside each box with padding and boxes grow taller to fit them; the result lists the final size of every box and any overlaps that growth caused (call fit_to_text once to push them apart). The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        elements: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              label: {
                type: 'string' as const,
                description: 'Text label for the rectangle',
              },
              x: {
                type: 'number' as const,
                description: 'X position (left edge). If not provided, auto-positions.',
              },
              y: {
                type: 'number' as const,
                description: 'Y position (top edge). If not provided, auto-positions.',
              },
              width: {
                type: 'number' as const,
                description: 'Width of the rectangle (default: 150)',
              },
              height: {
                type: 'number' as const,
                description: 'Minimum height of the rectangle (default: 80). It grows taller if its label needs more room.',
              },
              color: {
                type: 'string' as const,
                description: 'Fill color (hex code or color name)',
              },
              strokeColor: {
                type: 'string' as const,
                description: 'Border color (hex code or color name)',
              },
              rounded: {
                type: 'boolean' as const,
                description: 'Whether to use rounded corners (default: true)',
              },
            },
            required: ['label'],
          },
          description: 'Array of rectangle definitions to create',
        },
      },
      required: ['elements'],
    },
    handler: async (
      params: {
        elements: Array<{
          label: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          color?: string;
          strokeColor?: string;
          rounded?: boolean;
        }>;
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const currentElements = api.getSceneElements() || [];
      const engine = new LayoutEngine();
      engine.addElements(currentElements);

      const fontsReady = await ensureFontsReady(params.elements.map((d) => ({ text: d.label })));

      const specs: BoxSpec[] = [];
      params.elements.forEach((elemDef, index) => {
        const fit = fitLabel('rectangle', { width: elemDef.width || 150, height: elemDef.height || 80 }, elemDef.label);
        let position: { x: number; y: number };
        if (elemDef.x !== undefined && elemDef.y !== undefined) {
          position = { x: elemDef.x, y: elemDef.y };
        } else {
          position = engine.calculateDefaultPosition(fit.width, fit.height);
        }
        // Later boxes in this batch must see this one, or they land on top of it.
        engine.addNode(`batch-${index}`, position.x, position.y, fit.width, fit.height);
        specs.push({
          label: elemDef.label,
          x: position.x,
          y: position.y,
          fit,
          backgroundColor: normalizeColor(elemDef.color) || 'transparent',
          strokeColor: normalizeColor(elemDef.strokeColor) || '#1e1e1e',
          rounded: elemDef.rounded !== undefined ? elemDef.rounded : true,
        });
      });

      const { elements: newElements, boxes } = createLabeledBoxes(specs);
      const nextElements = [...currentElements, ...newElements];
      api.updateScene({ elements: nextElements });

      return {
        success: true,
        data: {
          created: boxes.length,
          ids: boxes.map((b) => b.id),
          elements: boxes.map((b) => ({ id: b.id, label: b.label, x: b.x, y: b.y, width: b.width, height: b.height })),
          ...layoutReport(nextElements, boxes.map((b) => b.id), fontsReady),
        },
      };
    },
  },

  {
    name: 'fit_to_text',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Make every label on the board fit its box, in one call. Waits for the drawing font, re-wraps each label inside real padding, grows each box taller (never shorter, width kept) until its text fits, pushes overlapping boxes down (x positions, columns and existing gaps are kept), grows frames around their content, re-aims arrows, and moves arrow labels off each other. Call it once after building a diagram, or on any existing board that looks cramped. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (
      _params: Record<string, never>,
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      const result = await fitBoard(api.getSceneElements());
      api.updateScene({ elements: result.elements });

      return {
        success: true,
        data: {
          resized: result.resized,
          moved: result.moved,
          rerouted: result.rerouted,
          ...(result.fontsReady ? {} : { warning: FONT_NOT_READY_WARNING }),
        },
      };
    },
  },

  {
    name: 'remove_elements',
    scope: 'global' as const,
    access: { kind: 'editor-write' } as const,
    description: 'Remove multiple elements in a single batch operation. Much more efficient than calling remove_element repeatedly. The target file must already exist but does not need to be open; Nimbalyst mounts it in a hidden editor from filePath. Do not call extension_test_open_file first.',
    parameters: {
      type: 'object' as const,
      properties: {
        labels: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Labels of elements to remove',
        },
        ids: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Element IDs to remove (alternative to labels)',
        },
      },
    },
    handler: async (
      params: {
        labels?: string[];
        ids?: string[];
      },
      context: { activeFilePath?: string; editorAPI?: unknown }
    ) => {
      const api = getEditorAPI(context);
      if (!api) {
        return noEditorError(context);
      }

      if ((!params.labels || params.labels.length === 0) && (!params.ids || params.ids.length === 0)) {
        return {
          success: false,
          error: 'Must provide either labels or ids array',
        };
      }

      const currentElements = api.getSceneElements();
      const idsToRemove = new Set<string>();

      // Find elements by labels
      if (params.labels) {
        for (const label of params.labels) {
          const element = getElementByLabel(currentElements, label);
          if (element) {
            idsToRemove.add(element.id);
            // If it's bound text, also remove container
            if ('containerId' in element && element.containerId) {
              idsToRemove.add(element.containerId as string);
            }
          }
        }
      }

      // Find elements by IDs
      if (params.ids) {
        for (const id of params.ids) {
          const element = currentElements.find(el => el.id === id);
          if (element) {
            idsToRemove.add(id);
            // If it's bound text, also remove container
            if ('containerId' in element && element.containerId) {
              idsToRemove.add(element.containerId as string);
            }
          }
        }
      }

      const updatedElements = currentElements.filter((el) => !idsToRemove.has(el.id));

      api.updateScene({ elements: updatedElements });

      return {
        success: true,
        data: {
          removed: idsToRemove.size,
        },
      };
    },
  },
];
