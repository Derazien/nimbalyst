import { useEffect, useState } from 'react';
import { buildAttachmentSupportMap, type AttachmentSupportMap } from './providerAttachmentSupport';

export interface ProviderAttachmentSupport {
  supportMap: AttachmentSupportMap;
  displayNames: ReadonlyMap<string, string>;
}

const EMPTY: ProviderAttachmentSupport = {
  supportMap: new Map<string, boolean>(),
  displayNames: new Map<string, string>(),
};

/**
 * Extension-contributed agent providers are static manifest data: the registry
 * only changes on an extension rescan, which requires a renderer reload. So we
 * fetch once per renderer and share the promise across every composer instead
 * of an IPC round-trip per mounted session.
 */
let cached: Promise<ProviderAttachmentSupport> | null = null;

async function load(): Promise<ProviderAttachmentSupport> {
  try {
    const result = await window.electronAPI.invoke('agent-providers:list');
    const entries = Array.isArray(result?.data) ? result.data : [];
    const displayNames = new Map<string, string>();
    for (const entry of entries) {
      if (entry && typeof entry.id === 'string' && typeof entry.name === 'string') {
        displayNames.set(entry.id, entry.name);
      }
    }
    return { supportMap: buildAttachmentSupportMap(entries), displayNames };
  } catch (error) {
    // Fail open: a provider list we could not read must not start refusing
    // attachments that used to work.
    console.error('[useProviderAttachmentSupport] Failed to list agent providers:', error);
    return EMPTY;
  }
}

export function useProviderAttachmentSupport(): ProviderAttachmentSupport {
  const [state, setState] = useState<ProviderAttachmentSupport>(EMPTY);

  useEffect(() => {
    let alive = true;
    cached ??= load();
    cached.then((value) => {
      if (alive) setState(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
