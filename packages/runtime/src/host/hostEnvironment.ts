/**
 * The host capability contract.
 *
 * `packages/runtime` is cross-platform by design, but two modules reached
 * directly for Electron's `app` object to answer two questions: "am I running
 * from a packaged build?" and "where is the application root?". That made the
 * Claude Code launch path unusable from any host without an Electron process.
 *
 * Those two questions are the entire Electron surface in runtime — eight call
 * sites, two primitives. This module states them as an interface so each host
 * answers them for itself: Electron from `app`, a headless Node process from
 * its own layout.
 *
 * Both are methods rather than fields on purpose. `app.isPackaged` and
 * `app.getAppPath()` must be read lazily at call time, never captured at module
 * load, because a singleton that reads them during import runs before the
 * Electron app is ready.
 */

export interface HostEnvironment {
  /**
   * True when running from a packaged application bundle whose resources live
   * inside an asar archive. A headless host answers false: there is no asar,
   * and the packaged-path construction that flag guards would resolve nowhere.
   */
  isPackaged(): boolean;

  /**
   * The application root. Under Electron this is `app.getAppPath()`, which
   * points inside `app.asar` in a packaged build. Callers that need the
   * unpacked sibling derive it themselves.
   */
  getAppPath(): string;
}

/**
 * The host used when nothing has been injected: a plain Node process, never
 * packaged, rooted at the working directory.
 *
 * This is the correct answer for `nimbalyst-node` and for unit tests, and it is
 * deliberately not an error. It is *not* correct for Electron, which is why
 * `packages/electron` registers its own during main-process startup — see
 * `registerElectronHostEnvironment`. A packaged Electron build that failed to
 * register would silently take the dev branch of every path resolution, so that
 * registration is covered by a test rather than left to review.
 */
export const nodeHostEnvironment: HostEnvironment = {
  isPackaged: () => false,
  getAppPath: () => process.cwd(),
};

let current: HostEnvironment = nodeHostEnvironment;

/**
 * Install the host implementation. Called once, early, by whichever package
 * owns the process. Passing null restores the Node default, which is what test
 * teardown wants.
 */
export function setHostEnvironment(host: HostEnvironment | null): void {
  current = host ?? nodeHostEnvironment;
}

export function getHostEnvironment(): HostEnvironment {
  return current;
}
