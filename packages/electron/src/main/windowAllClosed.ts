/**
 * What the app does when its last window goes away.
 *
 * Extracted from `index.ts` so the decision can be tested without booting the
 * main process, the same shape as `uncaughtException.ts`. The two inputs that
 * genuinely belong to `index.ts` (its quitting flag and its window factory) are
 * injected; everything else is read here.
 */

import { app } from 'electron';
import { logger } from './utils/logger';
import { isKeepRunningInTray } from './utils/store';

export interface WindowAllClosedDeps {
  /**
   * Live read of the module-local quitting flag in `index.ts`. A getter rather
   * than a value because the flag flips long after the handler is registered.
   */
  isAppQuitting: () => boolean;
  /**
   * True when the user closed the WorkspaceManager itself rather than a project
   * window. Reading it resets it, so this handler must call it at most once per
   * event.
   */
  wasWorkspaceManagerManuallyClosed: () => boolean;
  /** Opens the WorkspaceManager window. */
  showWorkspaceManager: () => void;
}

export function createWindowAllClosedHandler(deps: WindowAllClosedDeps): () => void {
  return () => {
    logger.main.info('All windows closed');

    // The quitting flag is read before anything else on purpose. Quit from the
    // menu closes every window, which fires this handler; consulting the tray
    // preference first would leave a headless process behind after the user
    // asked the app to end.
    if (deps.isAppQuitting()) {
      app.quit();
      return;
    }

    // The WorkspaceManager itself was closed by the user. Reopening it here
    // would make its close button do nothing.
    if (deps.wasWorkspaceManagerManuallyClosed()) {
      if (process.platform === 'darwin') {
        logger.main.info('WorkspaceManager manually closed on macOS, app stays running (dock icon can reopen)');
        return;
      }
      if (isKeepRunningInTray()) {
        logger.main.info('WorkspaceManager manually closed, keeping the app running in the tray');
        return;
      }
      logger.main.info('WorkspaceManager manually closed on non-macOS platform, quitting app');
      app.quit();
      return;
    }

    // A project window was closed, not the WorkspaceManager. Show it so the
    // user can open another project.
    if (app.isReady()) {
      logger.main.info('Project window closed, showing WorkspaceManager');
      deps.showWorkspaceManager();
    }
  };
}
