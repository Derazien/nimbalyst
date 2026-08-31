/**
 * Whether the active provider accepts attachments.
 *
 * Extension-contributed agent providers declare `supportsAttachments` in their
 * manifest, and the host already honours it when it decides whether to offer an
 * attach affordance. The composer's paste and drop paths did not read it at
 * all, so an image pasted into a provider that declares `supportsAttachments:
 * false` was still saved, still referenced in the prompt, and then dropped on
 * the floor by a backend with nowhere to put it -- the user saw the reference
 * go out and the agent answer that no image had arrived.
 *
 * The map is keyed by provider id and only ever contains extension-contributed
 * providers. Built-in providers, and any provider the map has not loaded yet,
 * are treated as supporting attachments: this gate exists to honour an explicit
 * "no", never to guess one, so an unknown provider keeps today's behaviour.
 */
export type AttachmentSupportMap = ReadonlyMap<string, boolean>;

export function providerSupportsAttachments(
  provider: string | null | undefined,
  supportMap: AttachmentSupportMap | null | undefined,
): boolean {
  if (!provider || !supportMap) return true;
  const declared = supportMap.get(provider);
  return declared === undefined ? true : declared;
}

/**
 * Build the provider-id -> supportsAttachments map from the `agent-providers:list`
 * payload. Entries that declare nothing are omitted rather than defaulted, so
 * "did not say" stays distinguishable from "said no".
 */
export function buildAttachmentSupportMap(
  entries: ReadonlyArray<{ id?: unknown; supportsAttachments?: unknown }> | null | undefined,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (typeof entry.supportsAttachments !== 'boolean') continue;
    map.set(entry.id, entry.supportsAttachments);
  }
  return map;
}

/** The toast copy for a rejected attachment, so paste and drop stay identical. */
export function attachmentUnsupportedMessage(
  providerDisplayName: string | null | undefined,
  kind: 'image' | 'file',
): { title: string; message: string } {
  const who = providerDisplayName?.trim() || 'This agent';
  return {
    title: 'Attachments not supported',
    message:
      `${who} cannot receive ${kind === 'image' ? 'images' : 'file attachments'} yet, ` +
      `so the ${kind === 'image' ? 'pasted image' : 'dropped file'} was not attached. ` +
      'Send the text, or a path the agent can read, instead.',
  };
}
