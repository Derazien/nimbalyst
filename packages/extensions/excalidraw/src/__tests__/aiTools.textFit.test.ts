import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests run the REAL @excalidraw/excalidraw: its own text wrapping and
// container growth, with a fixed width per character standing in for canvas
// metrics. Before the drawing font "loads" a character is 8px wide, after it
// 11px, which is the kind of gap between the fallback font and Excalifont that
// made boards come out cramped (tools measured before the font had loaded).
const CHAR_WIDTH = { fallback: 8, drawingFont: 11 };
const PAD_X = 16;
const PAD_Y = 12;
let fontLoaded = false;

// jsdom has no canvas, FontFace or document.fonts; Excalidraw needs all three.
const faces = new Set<unknown>();
const fakeContext = new Proxy(
  { filter: 'none', canvas: { setAttribute() {}, style: {} } } as Record<string, unknown>,
  { get: (target, prop: string) => (prop in target ? target[prop] : () => undefined) },
);
(HTMLCanvasElement.prototype as any).getContext = () => fakeContext;
(globalThis as any).FontFace ??= class {
  family: string;
  unicodeRange: string;
  constructor(family: string, _source: string, descriptors?: { unicodeRange?: string }) {
    this.family = family;
    this.unicodeRange = descriptors?.unicodeRange ?? 'U+0-10FFFF';
  }
};
(document as any).fonts = {
  has: (face: unknown) => faces.has(face),
  add: (face: unknown) => faces.add(face),
  forEach: (cb: (face: unknown) => void) => faces.forEach(cb),
  check: () => fontLoaded,
  load: () =>
    new Promise((resolve) =>
      setTimeout(() => {
        fontLoaded = true;
        resolve([...faces]);
      }, 5),
    ),
};

let excalidraw: typeof import('@excalidraw/excalidraw');
let aiTools: typeof import('../aiTools').aiTools;

beforeAll(async () => {
  // Imported after the stubs: Excalidraw probes the canvas at module load.
  excalidraw = await import('@excalidraw/excalidraw');
  excalidraw.setCustomTextMetricsProvider({
    getLineWidth: (text: string, font: string) =>
      (text.length * (fontLoaded ? CHAR_WIDTH.drawingFont : CHAR_WIDTH.fallback) * parseFloat(font)) / 20,
  });
  ({ aiTools } = await import('../aiTools'));
  // Rendering into the stub canvas is noisy and irrelevant here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  fontLoaded = true;
});

const LONG =
  'IDENTITY + SKILLS (files in locallead: .companion/IDENTITY.md, .claude/skills, 19 of them). Replaced: the Hermes persona.';
const LONG_2 = 'THE FRONT: session adcda9f7 in locallead, Opus 1M, role companion, pinned. The one you talk to.';

function tool(name: string): (params: any) => Promise<any> {
  const found = aiTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not found`);
  return (params) => (found.handler as any)(params, { editorAPI: api });
}

let api: ReturnType<typeof makeApi>;
function makeApi(initial: any[] = []) {
  let scene = initial;
  return {
    getSceneElements: () => scene.filter((el) => !el.isDeleted),
    updateScene: vi.fn(({ elements }: { elements?: any[] }) => {
      if (elements) scene = elements;
    }),
    addFiles: vi.fn(),
    get scene() {
      return scene;
    },
  };
}

const rectangles = () => api.scene.filter((el) => el.type === 'rectangle');
const boundTextOf = (container: any) => api.scene.find((el) => el.type === 'text' && el.containerId === container.id);
const renderedWidth = (line: string, fontSize = 20) => (line.length * CHAR_WIDTH.drawingFont * fontSize) / 20;
const overlap = (a: any, b: any) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every line of every label fits inside its box with padding, in the drawing font. */
function expectLabelsFit() {
  for (const box of rectangles()) {
    const text = boundTextOf(box);
    if (!text) continue;
    for (const line of text.text.split('\n')) {
      expect(renderedWidth(line, text.fontSize), line).toBeLessThanOrEqual(box.width - PAD_X * 2 + 0.01);
    }
    expect(box.height).toBeGreaterThanOrEqual(text.height + PAD_Y * 2 - 0.01);
  }
}

describe('labels fit their boxes', () => {
  it('measures a label in the drawing font, not the narrower fallback shown before it loads', async () => {
    fontLoaded = false;
    api = makeApi();

    const result = await tool('add_rectangle')({ label: LONG, x: 0, y: 0, width: 220, height: 60 });

    expect(result.success).toBe(true);
    expectLabelsFit();
  });

  it('wraps inside padding, keeps the width, grows the height and never shrinks it', async () => {
    api = makeApi();

    await tool('add_rectangle')({ label: 'Short', x: 0, y: 0, width: 220, height: 300 });
    const grown = await tool('add_rectangle')({ label: LONG, x: 300, y: 0, width: 220, height: 40 });

    const [tall, box] = rectangles();
    const text = boundTextOf(box);
    expect(tall.height).toBe(300);
    expect(box.width).toBe(220);
    expect(box.height).toBe(text.height + PAD_Y * 2);
    expect(grown.data).toMatchObject({ width: 220, height: box.height });
    expect(text.x - box.x).toBeGreaterThanOrEqual(PAD_X);
    expect(box.x + box.width - (text.x + text.width)).toBeGreaterThanOrEqual(PAD_X);
    expect(text.y - box.y).toBeGreaterThanOrEqual(PAD_Y);
    expect(box.y + box.height - (text.y + text.height)).toBeGreaterThanOrEqual(PAD_Y);
  });

  it('stacks add_column boxes by their grown heights and gives an add_row one shared height', async () => {
    api = makeApi();

    await tool('add_column')({ labels: [LONG, 'Short'], x: 0, y: 0, width: 220, height: 60, spacing: 20 });
    await tool('add_row')({ labels: ['Short', LONG], x: 0, y: 1000, width: 220, height: 60, spacing: 20 });

    const [first, second, left, right] = rectangles();
    expect(first.height).toBeGreaterThan(60);
    expect(second.y).toBe(first.y + first.height + 20);
    expect(left.height).toBe(right.height);
    expectLabelsFit();
  });

  it('reports boxes that grew into a neighbour, and spreads an auto-placed batch', async () => {
    api = makeApi();

    const placed = await tool('add_elements')({
      elements: [
        { label: LONG, x: 0, y: 0, width: 220, height: 60 },
        { label: 'Below', x: 0, y: 70, width: 220, height: 60 },
      ],
    });
    const auto = await tool('add_elements')({ elements: [{ label: 'One' }, { label: 'Two' }] });

    expect(placed.data.overlaps).toHaveLength(1);
    expect(placed.data.hint).toMatch(/fit_to_text/);
    const [one, two] = auto.data.elements;
    expect(overlap(one, two)).toBe(false);
  });

  it('re-wraps a label changed with update_element and bumps versions so a hidden editor saves it', async () => {
    api = makeApi();
    await tool('add_rectangle')({ label: 'Short', x: 0, y: 0, width: 220, height: 60 });
    const [before] = rectangles();

    await tool('update_element')({ id: before.id, newLabel: LONG });

    const [after] = rectangles();
    expect(after.height).toBeGreaterThan(60);
    expect(after.version).toBeGreaterThan(before.version);
    expect(boundTextOf(after).originalText).toBe(LONG);
    expectLabelsFit();
  });
});

describe('arrow labels do not stack', () => {
  const arrowLabels = () =>
    api.scene.filter((el) => el.type === 'text' && api.scene.find((a) => a.id === el.containerId)?.type === 'arrow');

  it('spreads two arrows that join the same boxes so their labels sit apart', async () => {
    api = makeApi();
    await tool('add_elements')({
      elements: [
        { label: 'Keeper', x: 0, y: 0, width: 400, height: 60 },
        { label: 'Loop', x: 0, y: 160, width: 400, height: 60 },
      ],
    });

    const result = await tool('add_arrows')({
      arrows: [
        { from: 'Keeper', to: 'Loop', label: 'every 2 min' },
        { from: 'Loop', to: 'Keeper', label: 'her own sweep row re-arms it' },
      ],
    });

    expect(result.data.created).toBe(2);
    const [a, b] = arrowLabels();
    expect(overlap(a, b)).toBe(false);
    for (const arrow of api.scene.filter((el) => el.type === 'arrow')) {
      expect(arrow.startBinding?.elementId).toBeTruthy();
      expect(arrow.endBinding?.elementId).toBeTruthy();
    }
  });

  it('moves a new label off a label already on the board', async () => {
    api = makeApi();
    await tool('add_elements')({
      elements: [
        { label: 'North west', x: 0, y: 0, width: 160, height: 60 },
        { label: 'North east', x: 400, y: 0, width: 160, height: 60 },
        { label: 'South west', x: 0, y: 400, width: 160, height: 60 },
        { label: 'South east', x: 400, y: 400, width: 160, height: 60 },
      ],
    });

    // Crossing arrows: both midpoints land on the same spot.
    await tool('add_arrow')({ from: 'North west', to: 'South east', label: 'first label' });
    await tool('add_arrow')({ from: 'North east', to: 'South west', label: 'second label' });

    const [a, b] = arrowLabels();
    expect(overlap(a, b)).toBe(false);
  });
});

describe('fit_to_text', () => {
  /** What the old tools built: Excalidraw's wrap in pre-load metrics, rows placed at the asked-for heights. */
  function crampedBoard() {
    fontLoaded = false;
    const skeleton = (x: number, y: number, width: number, height: number, text: string) => ({
      type: 'rectangle' as const, x, y, width, height, label: { text },
    });
    const boxes = excalidraw.convertToExcalidrawElements([
      skeleton(30, 60, 260, 100, LONG),
      skeleton(310, 60, 260, 40, 'Keeper'),
      skeleton(30, 170, 260, 100, LONG_2),
      skeleton(310, 110, 260, 60, 'Loop'),
      skeleton(30, 420, 540, 60, 'First box of the second frame'),
    ]) as any[];
    const frame = (id: string, y: number, height: number) => ({
      id, type: 'frame', name: id, x: 0, y, width: 600, height, angle: 0, version: 1, isDeleted: false,
      boundElements: null, groupIds: [], frameId: null,
    });
    const rects = boxes.filter((el) => el.type === 'rectangle');
    for (const el of boxes) {
      const owner = el.type === 'rectangle' ? el : rects.find((r) => r.id === el.containerId);
      el.frameId = owner.y < 400 ? 'frame-1' : 'frame-2';
    }
    // The two arrows the old add_arrows drew: one straight line, labels on one spot.
    const [, keeper, , loop] = rects;
    const arrow = (id: string, from: any, to: any, label: string) => {
      const [line, text] = excalidraw.convertToExcalidrawElements([
        {
          type: 'arrow', x: 440, y: from.y < to.y ? from.y + from.height + 8 : from.y - 8,
          points: [[0, 0], [0, from.y < to.y ? to.y - from.y - from.height - 16 : -(from.y - to.y - to.height - 16)]],
          label: { text: label, fontSize: 16 },
        } as any,
      ]) as any[];
      from.boundElements = [...(from.boundElements ?? []), { id: line.id, type: 'arrow' }];
      to.boundElements = [...(to.boundElements ?? []), { id: line.id, type: 'arrow' }];
      return [
        { ...line, id, startBinding: { elementId: from.id, focus: 0, gap: 8 }, endBinding: { elementId: to.id, focus: 0, gap: 8 }, boundElements: [{ id: text.id, type: 'text' }] },
        { ...text, containerId: id, frameId: 'frame-1' },
      ];
    };
    return [
      frame('frame-1', 0, 300),
      frame('frame-2', 360, 160),
      ...boxes,
      ...arrow('arrow-down', keeper, loop, 'every 2 min'),
      ...arrow('arrow-up', loop, keeper, 'her own sweep row re-arms it'),
    ];
  }

  it('makes every label fit, pushes boxes apart, grows frames and separates arrow labels', async () => {
    api = makeApi(crampedBoard());
    const before = new Map(api.scene.map((el) => [el.id, el.version]));

    const result = await tool('fit_to_text')({});

    expect(result.success).toBe(true);
    expect(result.data.resized).toBeGreaterThan(0);
    expectLabelsFit();

    const shapes = rectangles();
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) expect(overlap(shapes[i], shapes[j])).toBe(false);
    }
    const frames = api.scene.filter((el) => el.type === 'frame');
    expect(overlap(frames[0], frames[1])).toBe(false);
    for (const box of shapes) {
      const frame = frames.find((f) => f.id === box.frameId);
      expect(box.y).toBeGreaterThanOrEqual(frame.y);
      expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
    }

    const labels = api.scene.filter((el) => el.type === 'text' && el.containerId?.startsWith('arrow-'));
    expect(overlap(labels[0], labels[1])).toBe(false);

    // Changed elements carry a new version, or a hidden editor would not save them.
    const grown = shapes.find((s) => boundTextOf(s).originalText === LONG);
    expect(grown.version).toBeGreaterThan(before.get(grown.id)!);

    // One call is enough: a second pass over a fitted board changes nothing.
    const again = await tool('fit_to_text')({});
    expect(again.data).toMatchObject({ resized: 0, moved: 0, rerouted: 0 });
  });
});
