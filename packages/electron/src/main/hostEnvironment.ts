/**
 * Electron's answer to the runtime host capability contract.
 *
 * `packages/runtime` used to import `electron` directly to read `app.isPackaged`
 * and `app.getAppPath()`. Those were the only two Electron dependencies in the
 * package, and they blocked every non-Electron host. Runtime now asks an
 * injected `HostEnvironment`; this is the Electron one.
 *
 * Both members read `app` lazily at call time rather than capturing at module
 * load, so registering this before `app.whenReady()` is safe.
 */

import { app } from 'electron';
import { setHostEnvironment, type HostEnvironment } from '@nimbalyst/runtime/host/hostEnvironment';

export const electronHostEnvironment: HostEnvironment = {
  isPackaged: () => app.isPackaged,
  getAppPath: () => app.getAppPath(),
};

/**
 * Install the Electron host into runtime. Must run before anything resolves a
 * Claude binary path or builds SDK options.
 *
 * Skipping this is not a loud failure: runtime falls back to its Node default,
 * which reports "not packaged" and would send a packaged build down the dev
 * branch of every path resolution. That is why bootstrap calls this before it
 * imports the main entry, and why a unit test asserts the call happens.
 */
export function registerElectronHostEnvironment(): void {
  setHostEnvironment(electronHostEnvironment);
}
