import { afterEach, describe, expect, it, vi } from 'vitest';

// activate() only touches the collab service; nothing here needs Excalidraw itself.
vi.mock('../components/ExcalidrawEditor', () => ({ ExcalidrawEditor: () => null }));
vi.mock('../aiTools', () => ({ aiTools: [] }));
vi.mock('../collab/ExcalidrawCollabContentAdapter', () => ({ ExcalidrawCollabContentAdapter: {} }));

import { activate } from '../index';

function contextWith(assetBaseUrl?: string) {
  return {
    manifest: { id: 'com.nimbalyst.excalidraw' },
    extensionPath: '/extensions/excalidraw',
    assetBaseUrl,
    subscriptions: [],
    services: { collab: { registerContentAdapter: vi.fn() } },
  } as any;
}

describe('fonts shipped with the extension', () => {
  afterEach(() => {
    delete window.EXCALIDRAW_ASSET_PATH;
  });

  // Online, a missing asset path is invisible: Excalidraw quietly uses its CDN.
  it('points Excalidraw at dist/fonts on activation, leaving a path the host set alone', async () => {
    await activate(contextWith(undefined));
    expect(window.EXCALIDRAW_ASSET_PATH).toBeUndefined();

    await activate(contextWith('nim-extension://6578/'));
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('nim-extension://6578/dist/');

    window.EXCALIDRAW_ASSET_PATH = 'https://assets.example/excalidraw/';
    await activate(contextWith('nim-extension://6578/'));
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('https://assets.example/excalidraw/');
  });
});
