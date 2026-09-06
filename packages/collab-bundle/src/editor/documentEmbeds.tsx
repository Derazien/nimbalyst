import React from 'react';
import { buildCollabUri, isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import { setEmbedPluginCallbacks, type EmbedFrameProps } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import type { CollabEditorMountOptions } from './types';

/** The renderer is global, but document authority and preview ownership are not. */
export const BrowserDocumentEmbedContext = React.createContext<CollabEditorMountOptions['renderDecisionArtifact']>(undefined);

function sharedArtifact(src: string): string | null {
  try {
    if (isCollabUri(src)) {
      parseCollabUri(src);
      return src;
    }
    const url = new URL(src);
    if (url.protocol !== 'nimbalyst:' || url.hostname !== 'doc') return null;
    const path = url.pathname.replace(/^\/+/, '');
    const queryOrgId = url.searchParams.get('orgId');
    if (queryOrgId && path) return buildCollabUri(queryOrgId, decodeURIComponent(path));
    const [orgId, ...documentId] = path.split('/');
    return orgId && documentId.length ? buildCollabUri(decodeURIComponent(orgId), decodeURIComponent(documentId.join('/'))) : null;
  } catch { return null; }
}

function BrowserDocumentEmbed({ src, label, nodeKey }: EmbedFrameProps): React.JSX.Element {
  const render = React.useContext(BrowserDocumentEmbedContext);
  const artifact = sharedArtifact(src);
  const preview = artifact ? render?.(nodeKey, artifact) : null;
  return <div className="collab-bundle-document-embed" contentEditable={false}>
    {preview ?? <div className="collab-bundle-document-embed-unavailable">{label || 'Shared document'}: preview unavailable in this view.</div>}
  </div>;
}

/** Explicit call keeps registration in the production bundle. */
export function registerBrowserDocumentEmbeds(): void {
  setEmbedPluginCallbacks({ renderEmbed: BrowserDocumentEmbed });
}
