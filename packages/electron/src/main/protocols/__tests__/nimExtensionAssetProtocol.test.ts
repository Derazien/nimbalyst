// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { resolveExtensionAssetTarget } from '../nimExtensionAssetProtocol';
import { extensionAssetBaseUrl, extensionIdFromAssetHost } from '../../../shared/extensionAssetUrl';

const ID = 'com.nimbalyst.excalidraw';
const ROOT = resolve('/tmp/extensions/excalidraw');
const roots = new Map([[ID, ROOT]]);
const base = extensionAssetBaseUrl(ID);

function target(url: string) {
  return resolveExtensionAssetTarget(new URL(url), roots);
}

describe('nim-extension:// asset URLs', () => {
  it('serves a font addressed the way Excalidraw builds its URLs off EXCALIDRAW_ASSET_PATH', () => {
    // Excalidraw resolves "./fonts/<family>/<file>" against the asset path.
    const url = new URL('./fonts/Excalifont/Excalifont-Regular-a88b.woff2', new URL('dist/', base));
    expect(extensionIdFromAssetHost(url.hostname)).toBe(ID);
    expect(resolveExtensionAssetTarget(url, roots)).toEqual({
      extensionRoot: ROOT,
      filePath: join(ROOT, 'dist', 'fonts', 'Excalifont', 'Excalifont-Regular-a88b.woff2'),
      contentType: 'font/woff2',
    });
  });

  it('refuses anything outside the registered extension directory or the static-asset types', () => {
    // Dot segments are folded by the URL parser and cannot climb above the root.
    expect(target(`${base}%2e%2e/%2e%2e/x.woff2`)?.filePath).toBe(join(ROOT, 'x.woff2'));

    const refused = [
      `${extensionAssetBaseUrl('com.other.extension')}dist/fonts/a.woff2`, // not registered
      'nim-extension://zz/dist/fonts/a.woff2', // malformed host
      `${base}dist/..%2F..%2Fsecret.woff2`, // encoded separator
      `${base}dist/..%5C..%5Csecret.woff2`, // encoded backslash
      `${base}C:/Windows/Fonts/arial.ttf`, // drive letter
      `${base}dist/desktop.js`, // code
      `${base}manifest.json`, // data
      `${base}dist/fonts`, // no file type
      base, // the directory itself
    ];
    for (const url of refused) {
      expect(target(url), url).toBeNull();
    }
  });
});
