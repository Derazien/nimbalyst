/**
 * `collab-asset://` custom protocol — shared-document attachment bridge.
 *
 * Mirrors the `nim-asset://` pattern (see `nimAssetProtocol.ts`). The renderer
 * loads `<img src="collab-asset://doc/{documentId}/asset/{assetId}">` and
 * Chromium routes the request to this handler in main, where we:
 *   1. Translate `documentId` → `orgId` via the per-window registry.
 *   2. Fetch the asset from `sync.nimbalyst.com` with the org-scoped JWT.
 *   3. Check the stored-format marker the worker returns (NIM-2235) and serve
 *      plaintext blobs directly; anything else fails closed with a typed error.
 *   4. Hand the bytes back to the renderer with the right Content-Type.
 *
 * Why a custom protocol: the production worker only allows CORS from
 * `https://app.nimbalyst.com`, `https://nimbalyst.com`, `capacitor://localhost`.
 * The renderer at `http://localhost:5273` (dev) / `file://` (packaged) is
 * disallowed. Routing through main same-origins the request from Chromium's
 * perspective and lets us keep `webSecurity: true`.
 *
 * Auth gate: a renderer cannot probe assets for a doc the user has not
 * opened. The registry is populated by `document-sync:open` and torn down
 * by `document-sync:close-doc` from the tab unmount.
 */
import { protocol, net } from "electron";
import {
  COLLAB_ASSET_HEADER_ERROR_CODE,
  COLLAB_ASSET_HEADER_FILE_NAME,
  COLLAB_ASSET_HEADER_MIME,
  COLLAB_ASSET_HEADER_PLAINTEXT_SIZE,
  COLLAB_ASSET_HEADER_STORED_FORMAT,
  COLLAB_ASSET_HEADER_WIRE_FORMAT,
  COLLAB_ASSET_UNREADABLE_FORMAT_CODE,
  COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT,
  collabAssetUnreadableFormatMessage,
} from "@nimbalyst/runtime/sync/collabAssetFormat";

export const COLLAB_ASSET_SCHEME = "collab-asset";
export const COLLAB_ASSET_HOST = "doc";

/** Response header carrying the structured reason a blob could not be served. */
export const HEADER_ASSET_ERROR_CODE = COLLAB_ASSET_HEADER_ERROR_CODE;

export interface ParsedCollabAssetUrl {
  documentId: string;
  assetId: string;
}

interface RegistryEntry {
  orgId: string;
  refCount: number;
}

/**
 * Per-WebContents registry of opened documents. Keyed by webContents.id
 * so the IPC handlers (upload-asset, gc-assets, close-doc) can authorize
 * by sender -- a malicious renderer in window A cannot upload or
 * garbage-collect assets in a doc that only window B has opened.
 *
 * Note: the `protocol.handle` callback in current Electron does not
 * receive the requesting WebContents (see electron/electron#41472), so
 * the protocol-level authorization (`isCollabAssetDocumentRegistered`)
 * uses the union of all senders. This matches the existing `nim-asset://`
 * pattern (process-global allowlist) and is acceptable for our trust
 * model: all renderers are bundled by us. The IPC layer is where we can
 * enforce per-window scoping, and we do.
 */
const senderRegistry = new Map<number, Map<string, RegistryEntry>>();

/**
 * Sentinel sender ID for legacy callers that don't have a webContents
 * context (currently none). Kept separate from real webContents IDs so a
 * future WebContents whose ID happens to match doesn't gain a free pass.
 */
const ANONYMOUS_SENDER = -1;

/**
 * Pure-function URL parser. Exposed for unit tests and reused by the handler.
 *
 * Returns null if the input is not a well-formed
 * `collab-asset://doc/{documentId}/asset/{assetId}` URL.
 */
export function parseCollabAssetUrl(url: string): ParsedCollabAssetUrl | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${COLLAB_ASSET_SCHEME}:`) return null;
  if (parsed.hostname !== COLLAB_ASSET_HOST) return null;

  const match = parsed.pathname.match(/^\/([^/]+)\/asset\/([^/]+)$/);
  if (!match) return null;

  try {
    return {
      documentId: decodeURIComponent(match[1]),
      assetId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Register `(orgId, documentId)` for one sender (typically a renderer's
 * webContents.id). Refcounted per-sender so a single window opening the
 * same doc twice can decrement cleanly. Pass `ANONYMOUS_SENDER` for
 * non-IPC callers (currently none).
 */
export function registerCollabAssetDocument(
  orgId: string,
  documentId: string,
  senderId: number = ANONYMOUS_SENDER
): void {
  if (!orgId || !documentId) return;
  let docs = senderRegistry.get(senderId);
  if (!docs) {
    docs = new Map();
    senderRegistry.set(senderId, docs);
  }
  const existing = docs.get(documentId);
  if (existing) {
    if (existing.orgId !== orgId) {
      console.warn(
        "[collab-asset] documentId reused under a different orgId for the same sender; replacing entry",
        { senderId, documentId, oldOrgId: existing.orgId, newOrgId: orgId }
      );
      docs.set(documentId, { orgId, refCount: 1 });
      return;
    }
    existing.refCount += 1;
    return;
  }
  docs.set(documentId, { orgId, refCount: 1 });
}

/**
 * Decrement the per-sender refcount; remove the entry once it hits zero.
 * Idempotent past zero.
 */
export function unregisterCollabAssetDocument(
  documentId: string,
  senderId: number = ANONYMOUS_SENDER
): void {
  if (!documentId) return;
  const docs = senderRegistry.get(senderId);
  if (!docs) return;
  const existing = docs.get(documentId);
  if (!existing) return;
  existing.refCount -= 1;
  if (existing.refCount <= 0) {
    docs.delete(documentId);
    if (docs.size === 0) senderRegistry.delete(senderId);
  }
}

/**
 * Drop every entry for a sender. Call from the renderer's
 * `webContents.on('destroyed')` handler so a closed window's registrations
 * don't outlive the window.
 */
export function clearCollabAssetSender(senderId: number): void {
  senderRegistry.delete(senderId);
}

/**
 * Per-sender authorization check. Used by IPC handlers (upload-asset,
 * gc-assets) so a renderer in window A cannot operate on a doc only
 * window B has opened.
 */
export function isCollabAssetDocumentRegisteredForSender(
  senderId: number,
  orgId: string,
  documentId: string
): boolean {
  const docs = senderRegistry.get(senderId);
  if (!docs) return false;
  const entry = docs.get(documentId);
  return !!entry && entry.orgId === orgId;
}

/**
 * Process-wide authorization check. Used by `protocol.handle`, which
 * cannot determine the requesting webContents in current Electron (see
 * electron/electron#41472). Returns true if *any* sender has registered
 * (orgId, documentId). This intentionally trades strict per-window
 * isolation for being able to render `<img src="collab-asset://...">`
 * via the registered scheme at all -- and it matches the existing
 * `nim-asset://` pattern.
 */
export function isCollabAssetDocumentRegistered(
  orgId: string,
  documentId: string
): boolean {
  for (const docs of senderRegistry.values()) {
    const entry = docs.get(documentId);
    if (entry && entry.orgId === orgId) return true;
  }
  return false;
}

/**
 * Look up the orgId for a registered document, or null if not registered.
 * Process-wide (see `isCollabAssetDocumentRegistered`).
 */
export function getOrgIdForDocument(documentId: string): string | null {
  for (const docs of senderRegistry.values()) {
    const entry = docs.get(documentId);
    if (entry) return entry.orgId;
  }
  return null;
}

/**
 * For tests.
 */
export function clearCollabAssetRegistry(): void {
  senderRegistry.clear();
}

/**
 * The `collab-asset` scheme's privileges (standard/secure). Registered with
 * every other custom scheme in one call, see `privilegedSchemes.ts`.
 */
export const COLLAB_ASSET_PRIVILEGED_SCHEME: Electron.CustomScheme = {
  scheme: COLLAB_ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    corsEnabled: true,
  },
};

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

/**
 * Terminal, explicit refusal for a blob the server could not decode.
 *
 * 415 rather than 500 so the editor's broken-attachment placeholder settles
 * instead of retrying, and the structured code rides along for anything that
 * inspects it. Legacy client-encrypted attachments land here permanently:
 * their key is gone, and by decision they are not being recovered.
 */
function unreadableFormatResponse(storedFormat: string | null): Response {
  const message = collabAssetUnreadableFormatMessage(storedFormat);
  console.warn(
    "[collab-asset] Server refused to decode asset; stored format:",
    storedFormat ?? "unknown"
  );
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    [COLLAB_ASSET_HEADER_ERROR_CODE]: COLLAB_ASSET_UNREADABLE_FORMAT_CODE,
  });
  if (storedFormat) headers.set(COLLAB_ASSET_HEADER_STORED_FORMAT, storedFormat);
  return new Response(message, { status: 415, headers });
}

function decodeFileNameHeader(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded || null;
  } catch {
    return null;
  }
}

export interface AssetHandlerDeps {
  /** Mints (or returns cached) org-scoped JWT for the given org. */
  getOrgScopedJwt: (orgId: string) => Promise<string>;
  /** Resolves the collab server HTTP base URL (e.g. https://sync.nimbalyst.com). */
  getCollabHttpUrl: () => string;
  /** Current unlocked local account. Cache access is refused without it. */
  getAccountId?: () => string | null;
  assetStore?: {
    loadAsset(identity: {
      accountId: string;
      orgId: string;
      documentId: string;
      assetId: string;
    }): Promise<{
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
    } | null>;
    cacheAsset(input: {
      identity: {
        accountId: string;
        orgId: string;
        documentId: string;
        assetId: string;
      };
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
    }): Promise<void>;
  };
}

export type CollabAssetReadResult =
  | {
      ok: true;
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
      plaintextSize: string | null;
    }
  | {
      ok: false;
      kind: "auth" | "offline" | "not-found" | "unreadable" | "upstream";
      storedFormat?: string | null;
    };

/**
 * Read one shared-document asset through the same cache/auth/format-validation
 * path used by the custom protocol. Callers must supply the already-authorized
 * org/document identity; renderer authorization remains the protocol/IPC
 * layer's responsibility.
 */
export async function readCollabAsset(
  identity: { orgId: string; documentId: string; assetId: string },
  deps: AssetHandlerDeps,
): Promise<CollabAssetReadResult> {
  const accountId = deps.getAccountId?.() ?? null;
  const cacheIdentity = accountId
    ? { accountId, ...identity }
    : null;
  if (cacheIdentity && deps.assetStore) {
    try {
      const cached = await deps.assetStore.loadAsset(cacheIdentity);
      if (cached) {
        return {
          ok: true,
          bytes: cached.bytes,
          mimeType: cached.mimeType,
          fileName: cached.fileName,
          plaintextSize: null,
        };
      }
    } catch (error) {
      console.warn("[collab-asset] Cached asset unreadable; falling back to server", error);
    }
  }

  let jwt: string;
  try {
    jwt = await deps.getOrgScopedJwt(identity.orgId);
  } catch (err) {
    console.warn("[collab-asset] Failed to mint org JWT:", err);
    return { ok: false, kind: "auth" };
  }

  const assetUrl =
    `${deps.getCollabHttpUrl()}/api/collab/docs/` +
    `${encodeURIComponent(identity.documentId)}/assets/${encodeURIComponent(identity.assetId)}`;
  let upstream: Response;
  try {
    upstream = await net.fetch(assetUrl, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch {
    return { ok: false, kind: "offline" };
  }

  if (upstream.status === 404) return { ok: false, kind: "not-found" };
  if (
    upstream.headers.get(COLLAB_ASSET_HEADER_ERROR_CODE) ===
    COLLAB_ASSET_UNREADABLE_FORMAT_CODE
  ) {
    return {
      ok: false,
      kind: "unreadable",
      storedFormat: upstream.headers.get(COLLAB_ASSET_HEADER_STORED_FORMAT),
    };
  }
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    console.warn("[collab-asset] Upstream fetch failed", upstream.status, body);
    return { ok: false, kind: "upstream" };
  }

  const wireFormat =
    upstream.headers.get(COLLAB_ASSET_HEADER_WIRE_FORMAT) ??
    COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT;
  if (wireFormat !== COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT) {
    return {
      ok: false,
      kind: "unreadable",
      storedFormat: upstream.headers.get(COLLAB_ASSET_HEADER_STORED_FORMAT) ?? wireFormat,
    };
  }

  const mimeType =
    upstream.headers.get(COLLAB_ASSET_HEADER_MIME) ||
    "application/octet-stream";
  const plaintextSize = upstream.headers.get(COLLAB_ASSET_HEADER_PLAINTEXT_SIZE);
  const fileName =
    decodeFileNameHeader(upstream.headers.get(COLLAB_ASSET_HEADER_FILE_NAME)) ??
    `${identity.assetId}.bin`;
  const bytes = new Uint8Array(await upstream.arrayBuffer());

  if (cacheIdentity && deps.assetStore) {
    try {
      await deps.assetStore.cacheAsset({
        identity: cacheIdentity,
        bytes,
        mimeType,
        fileName,
      });
    } catch (error) {
      console.warn("[collab-asset] Failed to cache viewed asset", error);
    }
  }

  return { ok: true, bytes, mimeType, fileName, plaintextSize };
}

function assetResponse(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  plaintextSize?: string | null
): Response {
  const headers = new Headers();
  headers.set("Content-Type", mimeType || "application/octet-stream");
  headers.set("Content-Length", String(bytes.byteLength));
  if (plaintextSize) headers.set("X-Plaintext-Size", plaintextSize);
  headers.set(
    "Content-Disposition",
    `inline; filename="${fileName.replace(/[\r\n"]/g, "")}"`
  );
  return new Response(bytes as BodyInit, { status: 200, headers });
}

/**
 * Wire up the actual handler. Dependencies are injected so tests can stub
 * fetch / key lookup. In production wiring see `registerCollabAssetProtocolHandler`.
 */
export function installCollabAssetProtocolHandler(
  deps: AssetHandlerDeps
): void {
  protocol.handle(COLLAB_ASSET_SCHEME, createCollabAssetRequestHandler(deps));
}

export function createCollabAssetRequestHandler(deps: AssetHandlerDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      const parsed = parseCollabAssetUrl(request.url);
      if (!parsed) {
        return new Response("Bad request", { status: 400 });
      }

      const orgId = getOrgIdForDocument(parsed.documentId);
      if (!orgId) {
        // Not registered = renderer hasn't opened this doc in this session,
        // or the tab was already torn down. Treat as forbidden.
        return new Response("Forbidden", { status: 403 });
      }

      const result = await readCollabAsset({
        orgId,
        documentId: parsed.documentId,
        assetId: parsed.assetId,
      }, deps);
      if (!result.ok) {
        switch (result.kind) {
          case "auth": return new Response("Auth failed", { status: 401 });
          case "offline": return new Response("Attachment unavailable offline", { status: 503 });
          case "not-found": return new Response("Not found", { status: 404 });
          case "unreadable": return unreadableFormatResponse(result.storedFormat ?? null);
          case "upstream": return new Response("Upstream error", { status: 502 });
        }
      }
      return assetResponse(
        result.bytes,
        result.mimeType,
        result.fileName,
        result.plaintextSize,
      );
    } catch (err) {
      console.error("[collab-asset] handler error:", err);
      return new Response("Internal error", { status: 500 });
    }
  };
}
