/**
 * Follow an open-document request to the project it names.
 *
 * Main resolves "the window that shows project X" by workspace path, and with the project rail
 * that is often this very window, showing a different project. The request then waits in the
 * pending-open queue for a project that is not on screen, and the "Open in <project>" button
 * looks broken. When the request names a project that is not the one on screen, the rail
 * switches to it, and that project's editor drains the queued request.
 *
 * Requests with no project are every legacy sender (open from the OS, tracker links, extension
 * services): the rail is left alone and they open here as before.
 */

import { pathsEqual } from '../../../shared/projectLocator';

export interface OpenDocumentPayload {
  path: string;
  /** The project the file belongs to, when the sender knows. */
  workspacePath?: string | null;
}

export interface OpenDocumentDeps {
  /** The project this window is showing right now. */
  activeWorkspace: string | null | undefined;
  /** Make `project` the one on screen (rail switch, registering it if needed). False if it cannot. */
  activateProject: (project: string) => Promise<boolean>;
}

/**
 * - `here`: the request opens in the project already on screen (or names none).
 * - `switched`: the rail now shows the request's project.
 * - `unreachable`: the project would not activate. The caller should open the file here rather
 *   than lose the click.
 */
export type OpenDocumentRoute = 'here' | 'switched' | 'unreachable';

export async function routeOpenDocumentRequest(
  payload: OpenDocumentPayload,
  deps: OpenDocumentDeps,
): Promise<OpenDocumentRoute> {
  const project = payload.workspacePath?.trim();
  if (!project || pathsEqual(project, deps.activeWorkspace)) return 'here';
  return (await deps.activateProject(project)) ? 'switched' : 'unreachable';
}
