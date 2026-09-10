/**
 * `nim-extension://` URLs name files an extension ships beside its bundle
 * (fonts, images), served by the main process from the extension's own
 * directory.
 *
 * Extension modules load from blob URLs and their CSS is injected inline, so
 * without this nothing an extension ships has a URL the renderer can fetch, and
 * libraries that load assets by URL (Excalidraw's fonts) fall back to a CDN.
 *
 * URL shape: `nim-extension://<hex-extension-id>/<path inside the extension>`.
 * The id is hex-encoded so any manifest id is a valid host, the same way
 * `nim-preview://` carries its workspace root.
 */
export const NIM_EXTENSION_SCHEME = 'nim-extension';

/** Base URL, with a trailing slash, of an extension's installation directory. */
export function extensionAssetBaseUrl(extensionId: string): string {
  const hex = Array.from(new TextEncoder().encode(extensionId), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${NIM_EXTENSION_SCHEME}://${hex}/`;
}

/** The extension id a `nim-extension://` host names, or null for a malformed host. */
export function extensionIdFromAssetHost(host: string): string | null {
  if (!host || host.length % 2 !== 0 || !/^[0-9a-f]+$/.test(host)) return null;
  const bytes = new Uint8Array(host.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(host.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
