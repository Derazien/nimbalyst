/** Opaque document anchor identities, shared by queued and live navigation. */
export interface SharedDocumentAnchor { blockId?: string; threadId?: string; commentId?: string }

export function parseDocumentDeepLinkAnchor(url: URL): SharedDocumentAnchor {
  const result: SharedDocumentAnchor = {};
  for (const key of ['blockId', 'threadId', 'commentId'] as const) {
    const value = url.searchParams.get(key);
    if (value && value.length <= 200 && !/[\u0000-\u001F\u007F]/u.test(value)) result[key] = value;
  }
  return result;
}
