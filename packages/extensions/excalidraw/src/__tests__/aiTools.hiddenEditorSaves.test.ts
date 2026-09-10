// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// aiTools imports these at module load; the tools below never need real ones.
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: vi.fn((elements: any[]) =>
    elements.map((el, i) => ({ id: el.id ?? `conv-${el.type}-${i}`, version: 1, versionNonce: 1, ...el }))
  ),
}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: vi.fn(),
}));

import { aiTools } from '../aiTools';

// A file that is not open in a tab is edited through a hidden editor, and the
// hidden editor saves only when an element's version changes (its onChange
// compares id -> version; the collab binding does the same). Excalidraw's
// updateScene does not bump versions, so every element a tool rewrites must
// come back with a higher version and a new versionNonce, or the edit is
// silently dropped.
function scene() {
  const box = (id: string, x: number, label: string) => [
    { id, type: 'rectangle', x, y: 0, width: 100, height: 60, version: 3, versionNonce: 11, boundElements: [{ id: `${id}-text`, type: 'text' }], groupIds: [], frameId: null },
    { id: `${id}-text`, type: 'text', x: x + 10, y: 20, width: 80, height: 25, text: label, originalText: label, containerId: id, version: 3, versionNonce: 12, groupIds: [], frameId: null },
  ];
  return [
    { id: 'frame', type: 'frame', name: 'Frame', x: -50, y: -50, width: 800, height: 300, version: 2, versionNonce: 5, groupIds: [], frameId: null },
    ...box('a', 0, 'Alpha'),
    ...box('b', 250, 'Beta'),
    ...box('c', 400, 'Gamma'),
  ];
}

const withoutVersion = ({ version, versionNonce, updated, ...rest }: any) => JSON.stringify(rest);

const cases: Array<[string, Record<string, unknown>]> = [
  ['move_element', { label: 'Alpha', dx: 40 }],
  ['align_elements', { labels: ['Alpha', 'Beta'], alignment: 'top' }],
  ['distribute_elements', { labels: ['Alpha', 'Beta', 'Gamma'], direction: 'horizontal' }],
  ['group_elements', { labels: ['Alpha', 'Beta'] }],
  ['set_elements_in_frame', { frameLabel: 'Frame', elementLabels: ['Alpha'] }],
  ['update_element', { label: 'Alpha', color: 'red' }],
  ['add_arrow', { from: 'Alpha', to: 'Beta' }],
];

describe('tools that rewrite elements get them saved by a hidden editor', () => {
  it.each(cases)('%s bumps the version of every element it rewrites', async (name, params) => {
    const before = scene();
    // Make align/distribute actually move something.
    before.find((el) => el.id === 'b')!.y = 30;
    before.find((el) => el.id === 'b-text')!.y = 50;
    const api = { getSceneElements: () => before, updateScene: vi.fn(), addFiles: vi.fn() };
    const tool = aiTools.find((t) => t.name === name)!;

    const result = await (tool.handler as any)(params, { editorAPI: api });

    expect(result.success, JSON.stringify(result)).toBe(true);
    const after: any[] = api.updateScene.mock.calls[0][0].elements;
    const rewritten = after.filter((el) => {
      const old = before.find((b) => b.id === el.id);
      return old && withoutVersion(old) !== withoutVersion(el);
    });
    expect(rewritten.length).toBeGreaterThan(0);
    for (const el of rewritten) {
      const old = before.find((b) => b.id === el.id)!;
      expect(el.version, el.id).toBeGreaterThan(old.version);
      expect(el.versionNonce, el.id).not.toBe(old.versionNonce);
    }
  });
});
