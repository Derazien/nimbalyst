/**
 * `nim-extension://` custom protocol -- static files an extension ships.
 *
 * URL shape and the reason it exists: see `shared/extensionAssetUrl.ts`.
 *
 * A request is served only if:
 *   1. its host decodes to an extension id the extension scan registered
 *      (`initializeExtensionFileTypes` populates the registry at boot and after
 *      every install or uninstall),
 *   2. the resolved and realpath'd file lives under that extension's directory,
 *   3. the file type is a static asset (fonts, raster images). Nothing
 *      executable and nothing that carries data: an extension's JS, manifest
 *      and settings stay unreachable by URL.
 */
import { protocol } from 'electron';
import { readFile, realpath } from 'fs/promises';
import { extname, resolve, sep } from 'path';
import { NIM_EXTENSION_SCHEME, extensionIdFromAssetHost } from '../../shared/extensionAssetUrl';

const CONTENT_TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const extensionRoots = new Map<string, string>();

/**
 * Register the directory an extension id serves from. The first registration
 * of an id wins until the next clear, matching the scan order (user extensions
 * before built-in ones).
 */
export function setExtensionAssetRoot(extensionId: string, extensionPath: string): void {
  if (!extensionId || !extensionPath || extensionRoots.has(extensionId)) return;
  extensionRoots.set(extensionId, resolve(extensionPath));
}

export function clearExtensionAssetRoots(): void {
  extensionRoots.clear();
}

export interface ExtensionAssetTarget {
  extensionRoot: string;
  filePath: string;
  contentType: string;
}

/**
 * Pure: what a `nim-extension://` URL may serve, or null when it must not be
 * served (unknown extension, a path leaving the extension's directory, or a
 * file type outside the allowlist). Symlinks are checked at request time.
 */
export function resolveExtensionAssetTarget(
  url: URL,
  roots: ReadonlyMap<string, string>,
): ExtensionAssetTarget | null {
  if (url.protocol !== `${NIM_EXTENSION_SCHEME}:`) return null;
  const extensionId = extensionIdFromAssetHost(url.hostname);
  const registeredRoot = extensionId ? roots.get(extensionId) : undefined;
  if (!registeredRoot) return null;
  const extensionRoot = resolve(registeredRoot);

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.length === 0) return null;
  // An encoded separator, drive letter or dot segment has no business in an
  // asset path; refusing them keeps resolve() from ever leaving the root.
  if (segments.some((s) => s === '.' || s === '..' || /[\\/:\0]/.test(s))) return null;

  const contentType = CONTENT_TYPES[extname(segments[segments.length - 1]).toLowerCase()];
  if (!contentType) return null;

  const filePath = resolve(extensionRoot, ...segments);
  if (!filePath.startsWith(extensionRoot + sep)) return null;
  return { extensionRoot, filePath, contentType };
}

/**
 * The scheme's privileges, registered with every other custom scheme in one
 * call (see `privilegedSchemes.ts`). `corsEnabled` plus the handler's
 * Access-Control-Allow-Origin header is what lets a FontFace load from it:
 * font requests are CORS requests and the renderer's origin differs.
 */
export const NIM_EXTENSION_PRIVILEGED_SCHEME: Electron.CustomScheme = {
  scheme: NIM_EXTENSION_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    corsEnabled: true,
  },
};

/** Wire up the request handler. Call once after `app.whenReady`. */
export function registerNimExtensionAssetProtocolHandler(): void {
  protocol.handle(NIM_EXTENSION_SCHEME, async (request) => {
    try {
      const target = resolveExtensionAssetTarget(new URL(request.url), extensionRoots);
      if (!target) {
        return new Response('Forbidden', { status: 403 });
      }

      let real: string;
      try {
        real = await realpath(target.filePath);
      } catch {
        return new Response('Not found', { status: 404 });
      }
      const realRoot = await realpath(target.extensionRoot).catch(() => target.extensionRoot);
      if (!real.startsWith(realRoot + sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      const body = await readFile(real);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': target.contentType,
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      console.error('[nim-extension] handler error:', err);
      return new Response('Internal error', { status: 500 });
    }
  });
}
