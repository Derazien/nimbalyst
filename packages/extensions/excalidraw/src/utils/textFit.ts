/**
 * Text that fits its box.
 *
 * Excalidraw wraps and measures bound text with the canvas font that is loaded
 * at that moment. Its fonts are not loaded until a scene asks for them, so the
 * AI tools, which run in a freshly mounted (often offscreen) editor, used to
 * measure against a fallback font 9-26% narrower than Excalifont. The text was
 * wrapped too long, then drawn in Excalifont and clipped to its measured width.
 * Everything here therefore waits for the real font first, and wraps through
 * Excalidraw's own convertToExcalidrawElements so the result matches what a
 * user typing the same label gets, only with real padding.
 */

import { convertToExcalidrawElements, exportToCanvas } from '@excalidraw/excalidraw';

/** Excalidraw's own inset between a container edge and its bound text (BOUND_TEXT_PADDING, not exported). */
export const EXCALIDRAW_TEXT_INSET = 5;
/** Space kept between a box border and its label, left and right. */
export const LABEL_PADDING_X = 16;
/** Space kept between a box border and its label, top and bottom. */
export const LABEL_PADDING_Y = 12;

export const DEFAULT_FONT_SIZE = 20;
/** Excalifont, the default font family in Excalidraw 0.18. */
export const DEFAULT_FONT_FAMILY = 5;
export const ARROW_LABEL_FONT_SIZE = 16;

/** How long a tool waits for the drawing font before measuring anyway. */
const FONT_WAIT_MS = 5000;

// Mirrors Excalidraw's FONT_FAMILY map and getFontFamilyFallbacks, used only to
// ask document.fonts whether a face is ready.
const FONT_FAMILY_NAMES: Record<number, string> = {
  1: 'Virgil',
  2: 'Helvetica',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
  9: 'Liberation Sans',
};

function fontString(fontSize: number, fontFamily: number): string {
  const name = FONT_FAMILY_NAMES[fontFamily];
  if (!name) return `${fontSize}px Segoe UI Emoji`;
  const fallbacks = fontFamily === 5 ? ', Xiaolai, Segoe UI Emoji' : ', Segoe UI Emoji';
  return `${fontSize}px ${name}${fallbacks}`;
}

export interface TextSample {
  text: string;
  fontFamily?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Make sure the font faces these texts need are loaded before anything is
 * measured. Excalidraw's export pipeline is the public way to get its bundled
 * faces registered with document.fonts and loaded for a set of characters, so
 * a one-pixel export of probe text does exactly that. Returns false when the
 * font could not be confirmed (offline, blocked); callers still measure, and
 * report it, because the fallback is then also what will be drawn.
 */
export async function ensureFontsReady(samples: TextSample[], timeoutMs = FONT_WAIT_MS): Promise<boolean> {
  const fonts = typeof document !== 'undefined' ? (document as any).fonts : undefined;
  if (!fonts || typeof fonts.check !== 'function') return true;

  const charsByFamily = new Map<number, Set<string>>();
  for (const sample of samples) {
    if (!sample.text) continue;
    const family = sample.fontFamily ?? DEFAULT_FONT_FAMILY;
    const chars = charsByFamily.get(family) ?? new Set<string>();
    for (const ch of sample.text) {
      if (ch.trim()) chars.add(ch);
    }
    charsByFamily.set(family, chars);
  }
  if (charsByFamily.size === 0) return true;

  const probes = convertToExcalidrawElements(
    [...charsByFamily].map(([fontFamily, chars], index) => ({
      type: 'text' as const,
      x: 0,
      y: index * 40,
      text: [...chars].join('') || 'A',
      fontFamily: fontFamily as any,
      fontSize: DEFAULT_FONT_SIZE,
    })),
  );
  try {
    await withTimeout(
      exportToCanvas({
        elements: probes as any,
        files: null,
        maxWidthOrHeight: 1,
        appState: { exportBackground: false } as any,
      }),
      timeoutMs,
    );
  } catch {
    // A failed export still leaves the check below to report the truth.
  }

  // Only trustworthy once the faces are registered, which the export just did:
  // check() answers true for a family document.fonts has never heard of.
  return [...charsByFamily].every(([fontFamily, chars]) =>
    fonts.check(fontString(DEFAULT_FONT_SIZE, fontFamily), [...chars].join('')),
  );
}

export interface LabelStyle {
  fontSize?: number;
  fontFamily?: number;
  lineHeight?: number;
  textAlign?: string;
  verticalAlign?: string;
}

export interface MeasuredText {
  /** The text with the line breaks Excalidraw's wrapping inserted. */
  text: string;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: number;
  lineHeight: number;
}

/**
 * Wrap `originalText` to at most `maxLineWidth` and measure it, using
 * Excalidraw's own wrapping and metrics (a throwaway bound-text probe).
 */
export function measureWrappedText(originalText: string, maxLineWidth: number, style: LabelStyle = {}): MeasuredText {
  const label: Record<string, unknown> = {
    text: originalText,
    fontSize: style.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: style.fontFamily ?? DEFAULT_FONT_FAMILY,
  };
  if (style.lineHeight) label.lineHeight = style.lineHeight;
  if (style.textAlign) label.textAlign = style.textAlign;
  if (style.verticalAlign) label.verticalAlign = style.verticalAlign;

  const probe = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x: 0,
      y: 0,
      width: Math.max(1, maxLineWidth) + EXCALIDRAW_TEXT_INSET * 2,
      height: 1,
      label: label as any,
    },
  ]);
  const text = probe.find((el) => el.type === 'text') as any;
  return {
    text: text?.text ?? originalText,
    width: text?.width ?? 0,
    height: text?.height ?? 0,
    fontSize: text?.fontSize ?? (label.fontSize as number),
    fontFamily: text?.fontFamily ?? (label.fontFamily as number),
    lineHeight: text?.lineHeight ?? style.lineHeight ?? 1.25,
  };
}

/** Measure unwrapped text (a free text element that sizes itself to its content). */
export function measureUnwrappedText(originalText: string, style: LabelStyle = {}): MeasuredText {
  const probe = convertToExcalidrawElements([
    {
      type: 'text',
      x: 0,
      y: 0,
      text: originalText,
      fontSize: style.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: (style.fontFamily ?? DEFAULT_FONT_FAMILY) as any,
      ...(style.lineHeight ? { lineHeight: style.lineHeight as any } : {}),
    },
  ]);
  const text = probe[0] as any;
  return {
    text: text?.text ?? originalText,
    width: text?.width ?? 0,
    height: text?.height ?? 0,
    fontSize: text?.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: text?.fontFamily ?? DEFAULT_FONT_FAMILY,
    lineHeight: text?.lineHeight ?? 1.25,
  };
}

type ContainerType = 'rectangle' | 'ellipse' | 'diamond' | string;

/**
 * Widest line a container of this type and width can hold with our padding.
 * Mirrors Excalidraw's getBoundTextMaxWidth, minus the extra padding.
 */
export function labelLineWidth(containerType: ContainerType, width: number): number {
  const extra = (LABEL_PADDING_X - EXCALIDRAW_TEXT_INSET) * 2;
  let excalidrawMax: number;
  if (containerType === 'ellipse') {
    excalidrawMax = Math.round((width / 2) * Math.SQRT2) - EXCALIDRAW_TEXT_INSET * 2;
  } else if (containerType === 'diamond') {
    excalidrawMax = Math.round(width / 2) - EXCALIDRAW_TEXT_INSET * 2;
  } else {
    excalidrawMax = width - EXCALIDRAW_TEXT_INSET * 2;
  }
  return Math.max(1, excalidrawMax - extra);
}

/**
 * Smallest container height that holds text of this height with our padding.
 * Mirrors Excalidraw's computeContainerDimensionForBoundText.
 */
export function containerHeightForText(containerType: ContainerType, textHeight: number): number {
  const padded = Math.ceil(textHeight) + (LABEL_PADDING_Y - EXCALIDRAW_TEXT_INSET) * 2;
  const inset = EXCALIDRAW_TEXT_INSET * 2;
  if (containerType === 'ellipse') return Math.round(((padded + inset) / Math.SQRT2) * 2);
  if (containerType === 'diamond') return 2 * (padded + inset);
  return padded + inset;
}

/** Smallest container width whose padded line width still holds `textWidth`. */
function containerWidthForText(containerType: ContainerType, textWidth: number): number {
  const padded = Math.ceil(textWidth) + LABEL_PADDING_X * 2;
  if (containerType === 'ellipse') return Math.ceil(padded * Math.SQRT2);
  if (containerType === 'diamond') return padded * 2;
  return padded;
}

/**
 * Where Excalidraw places bound text inside a container (computeBoundTextPosition).
 * Centered text stays centered, so our padding survives any later Excalidraw redraw.
 */
export function boundTextPosition(
  container: { type: ContainerType; x: number; y: number; width: number; height: number },
  text: { width: number; height: number; textAlign?: string; verticalAlign?: string },
): { x: number; y: number } {
  let offsetX = EXCALIDRAW_TEXT_INSET;
  let offsetY = EXCALIDRAW_TEXT_INSET;
  if (container.type === 'ellipse') {
    offsetX += (container.width / 2) * (1 - Math.SQRT2 / 2);
    offsetY += (container.height / 2) * (1 - Math.SQRT2 / 2);
  } else if (container.type === 'diamond') {
    offsetX += container.width / 4;
    offsetY += container.height / 4;
  }
  const innerWidth = container.width - offsetX * 2;
  const innerHeight = container.height - offsetY * 2;
  const originX = container.x + offsetX;
  const originY = container.y + offsetY;

  let x = originX + (innerWidth - text.width) / 2;
  if (text.textAlign === 'left') x = originX;
  else if (text.textAlign === 'right') x = originX + innerWidth - text.width;

  let y = originY + (innerHeight - text.height) / 2;
  if (text.verticalAlign === 'top') y = originY;
  else if (text.verticalAlign === 'bottom') y = originY + innerHeight - text.height;

  return { x, y };
}

export interface FittedLabel {
  width: number;
  height: number;
  text: MeasuredText;
  /** True when the container had to grow to hold its text. */
  grew: boolean;
}

/**
 * Size a container for its label: wrap to the padded line width, keep the
 * requested width, and grow the height (never shrink it) until the text fits.
 */
export function fitLabel(
  containerType: ContainerType,
  requested: { width: number; height: number },
  originalText: string,
  style: LabelStyle = {},
): FittedLabel {
  const measured = measureWrappedText(originalText, labelLineWidth(containerType, requested.width), style);
  const width = Math.max(requested.width, containerWidthForText(containerType, measured.width));
  const height = Math.max(requested.height, containerHeightForText(containerType, measured.height));
  return {
    width,
    height,
    text: measured,
    grew: width > requested.width || height > requested.height,
  };
}
