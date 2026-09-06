/**
 * `nim-asset://` custom protocol — local-image bridge for the renderer.
 *
 * Issue #146: the main BrowserWindow currently runs with `webSecurity: false`
 * because four components render local images via `<img src="file://...">`,
 * and `file://` is cross-origin to the renderer's `http://localhost:5273` /
 * `file:///.../index.html` origins. To restore `webSecurity: true`, we serve
 * those images through a registered custom scheme that the renderer can load
 * same-origin.
 *
 * URL shape:
 *   `nim-asset://local/<base64url-encoded-absolute-path>`
 *
 * The handler decodes the absolute path, resolves it (defending against
 * `..` and symlink escapes), and only serves it if:
 *   1. The resolved path lives under one of the allowlisted root prefixes
 *      (open workspace paths + `<userData>/chat-attachments`).
 *   2. The file extension is in the image allowlist.
 *
 * Both gates are required. The allowlist is populated dynamically as
 * workspaces are registered/unregistered.
 */
import { protocol, app, net } from "electron";
import { realpath, stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { resolve, sep, extname } from "path";
import { pathToFileURL } from "url";

export const NIM_ASSET_SCHEME = "nim-asset";
export const NIM_ASSET_HOST = "local";

const IMAGE_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
]);

/**
 * Media types served with byte-range support (see `parseRangeHeader`).
 *
 * Video is not just "an image that moves" as far as this handler is concerned.
 * Chromium's media loader reads an mp4's `moov` atom before it can report
 * duration, and `ffmpeg` only writes `moov` up front when asked for
 * `+faststart` -- screen recorders and cameras generally do not, so `moov`
 * lands after the payload. Serving the file as one sequential 200 response
 * means the media element never reaches `moov` and fails outright with
 * `MEDIA_ELEMENT_ERROR` code 4. A file that *does* start with `moov` loads,
 * but then seeks silently resolve to 0: the `seeked` event fires as though it
 * worked and `currentTime` never leaves the start.
 */
const MEDIA_EXTENSIONS = new Set<string>([".mp4"]);

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
};

/** Extensions this scheme will serve at all. */
const SERVABLE_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTENSIONS,
  ...MEDIA_EXTENSIONS,
]);

const allowedRoots = new Set<string>();

/**
 * Add a root prefix that `nim-asset://` is allowed to serve files from. Idempotent.
 * The path is resolved (but not realpath'd -- realpath happens at request time
 * so newly-created symlinks within the root are still resolved correctly).
 */
export function addNimAssetRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedRoots.add(resolve(rootAbsolutePath));
}

/**
 * Remove a previously-added root. Idempotent.
 */
export function removeNimAssetRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedRoots.delete(resolve(rootAbsolutePath));
}

/**
 * For tests.
 */
export function clearNimAssetRoots(): void {
  allowedRoots.clear();
}

/**
 * For tests.
 */
export function getNimAssetRoots(): string[] {
  return [...allowedRoots];
}

/**
 * Encode an absolute path into the `nim-asset://local/<encoded>` URL.
 * Used by the renderer-side helper to build URLs that round-trip cleanly.
 */
export function encodeNimAssetUrl(absolutePath: string): string {
  const encoded = Buffer.from(absolutePath, "utf8").toString("base64url");
  return `${NIM_ASSET_SCHEME}://${NIM_ASSET_HOST}/${encoded}`;
}

/**
 * Pure-function path validator. Exposed for unit tests.
 *
 * Rejects with `null` if:
 *   - `requestedAbsPath` is empty / not absolute / contains null bytes
 *   - resolved path escapes every allowed root
 *   - file extension is not in the servable allowlist
 *
 * Returns the resolved (but NOT yet realpath'd) absolute path on success.
 * Realpath checking is async and happens in the request handler.
 */
export function validateNimAssetPath(
  requestedAbsPath: string,
  roots: Iterable<string>,
): string | null {
  if (!requestedAbsPath) return null;
  if (requestedAbsPath.includes("\0")) return null;

  // Reject `..` traversal explicitly. We split on both POSIX and Windows
  // separators because the renderer may emit a mixed-separator path
  // (e.g. on Windows, `C:\Users\me\doc/assets/img.png`) -- a
  // `normalize() === input` check would over-reject those legitimate
  // paths, so we look for `..` segments directly.
  const segments = requestedAbsPath.split(/[/\\]+/);
  if (segments.includes("..")) return null;

  const resolved = resolve(requestedAbsPath);

  const ext = extname(resolved).toLowerCase();
  if (!SERVABLE_EXTENSIONS.has(ext)) return null;

  let matched = false;
  for (const root of roots) {
    const rootResolved = resolve(root);
    if (resolved === rootResolved || resolved.startsWith(rootResolved + sep)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  return resolved;
}

/** An inclusive byte range, as `Content-Range` reports it. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range HTTP `Range` header against a known file size.
 *
 * Pure so the interesting cases are testable without an Electron process --
 * this branch only ever runs behind a real `protocol.handle`, which is exactly
 * the shape of code that never gets exercised under observation.
 *
 * Returns:
 *   - `null` when there is no range to honor (absent, non-`bytes`, malformed,
 *     or multi-range). The caller serves a normal 200.
 *   - `"unsatisfiable"` when the range is well-formed but outside the file.
 *     The caller must answer 416, not 200 -- a media element treats a 200 here
 *     as a redelivered stream and mis-seeks.
 *   - a clamped inclusive `{ start, end }` otherwise.
 *
 * Multi-range (`bytes=0-9,20-29`) is deliberately declined rather than
 * half-honored: a multipart/byteranges response is a different body format,
 * and Chromium's media loader never asks for one.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  if (!spec || spec.includes(",")) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;

  const [, rawStart, rawEnd] = parts;
  if (!rawStart && !rawEnd) return null;

  // An empty file cannot satisfy any range, including a suffix range.
  if (size <= 0) return "unsatisfiable";

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix form `bytes=-N`: the last N bytes. `bytes=-0` asks for nothing.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (start >= size) return "unsatisfiable";
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
    if (end < start) return "unsatisfiable";
  }

  return { start, end };
}

/**
 * Register the `nim-asset` scheme as standard/secure with Chromium. Must be
 * called BEFORE `app.whenReady` resolves -- per Electron docs, schemes must
 * be registered as privileged before the app is ready.
 */
export function registerNimAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NIM_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        // Avoid the default same-origin restriction: the scheme is treated
        // as standard/secure, which is enough for `<img src=>` to load it
        // from any origin in the renderer.
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Stream a media file, honoring `Range`. `net.fetch` on a `file://` URL does
 * not answer range requests, so media is read here instead: the range is
 * parsed against the real size and only the requested slice is streamed, which
 * is what lets a media element reach a trailing `moov` atom and seek.
 */
async function serveMediaWithRange(
  absolutePath: string,
  ext: string,
  rangeHeader: string | null,
): Promise<Response> {
  const contentType = MEDIA_CONTENT_TYPES[ext] ?? "application/octet-stream";

  const { size } = await stat(absolutePath);
  const range = parseRangeHeader(rangeHeader, size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const { start, end } = range ?? { start: 0, end: Math.max(0, size - 1) };
  const body = Readable.toWeb(
    createReadStream(absolutePath, { start, end }),
  ) as ReadableStream<Uint8Array>;

  if (!range) {
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        // Advertised even on the full response so the media element knows it
        // may seek at all -- without it Chromium will not issue a range request.
        "Accept-Ranges": "bytes",
      },
    });
  }

  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * Wire up the actual handler. Call once after `app.whenReady`. Adds the
 * userData/chat-attachments root automatically.
 */
export function registerNimAssetProtocolHandler(): void {
  // Auto-allow chat-attachments (the renderer's AttachmentPreview component
  // points at files under here).
  const userData = app.getPath("userData");
  addNimAssetRoot(`${userData}${sep}chat-attachments`);

  protocol.handle(NIM_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);

      if (url.host !== NIM_ASSET_HOST) {
        return new Response("Not found", { status: 404 });
      }

      // url.pathname starts with "/<encoded>"; trim the leading slash.
      const encoded = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!encoded) {
        return new Response("Bad request", { status: 400 });
      }

      let decoded: string;
      try {
        decoded = Buffer.from(encoded, "base64url").toString("utf8");
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      const resolved = validateNimAssetPath(decoded, allowedRoots);
      if (!resolved) {
        return new Response("Forbidden", { status: 403 });
      }

      // Defend against symlinks pointing outside the root by realpath'ing
      // and re-checking. realpath throws if the file does not exist.
      let real: string;
      try {
        real = await realpath(resolved);
      } catch {
        return new Response("Not found", { status: 404 });
      }

      let realInsideRoot = false;
      for (const root of allowedRoots) {
        const rootResolved = await realpath(root).catch(() => resolve(root));
        if (real === rootResolved || real.startsWith(rootResolved + sep)) {
          realInsideRoot = true;
          break;
        }
      }
      if (!realInsideRoot) {
        return new Response("Forbidden", { status: 403 });
      }

      const ext = extname(real).toLowerCase();
      if (MEDIA_EXTENSIONS.has(ext)) {
        return serveMediaWithRange(real, ext, request.headers.get("range"));
      }

      // Hand the read off to net.fetch on the file:// URL. This streams the
      // file with the right content-type and avoids reading into a Buffer.
      return net.fetch(pathToFileURL(real).toString());
    } catch (err) {
      console.error("[nim-asset] handler error:", err);
      return new Response("Internal error", { status: 500 });
    }
  });
}
