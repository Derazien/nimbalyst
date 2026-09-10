/**
 * Every custom scheme the app serves, registered as privileged in ONE call.
 *
 * Electron hands renderer processes the secure, CORS and fetch scheme lists of
 * the last `registerSchemesAsPrivileged` call only: each call rewrites the
 * command-line switch the renderers copy (`--cors-schemes=` and friends). With
 * one call per scheme, only the scheme registered last kept those privileges in
 * the renderer. Add a new scheme to this list, never a call of its own.
 *
 * Must run BEFORE `app.whenReady` resolves. The request handlers are wired
 * after it, by each protocol module.
 */
import { protocol } from 'electron';
import { NIM_ASSET_PRIVILEGED_SCHEME } from './nimAssetProtocol';
import { NIM_PREVIEW_PRIVILEGED_SCHEME } from './nimPreviewProtocol';
import { COLLAB_ASSET_PRIVILEGED_SCHEME } from './collabAssetProtocol';
import { NIM_EXTENSION_PRIVILEGED_SCHEME } from './nimExtensionAssetProtocol';

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    NIM_ASSET_PRIVILEGED_SCHEME,
    NIM_PREVIEW_PRIVILEGED_SCHEME,
    COLLAB_ASSET_PRIVILEGED_SCHEME,
    NIM_EXTENSION_PRIVILEGED_SCHEME,
  ]);
}
