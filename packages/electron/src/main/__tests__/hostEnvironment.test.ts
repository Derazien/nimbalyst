import { describe, it, expect, vi, afterEach } from 'vitest';

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getAppPath: vi.fn(() => '/Applications/Nimbalyst.app/Contents/Resources/app.asar'),
}));

vi.mock('electron', () => ({ app: appMock }));

import { setHostEnvironment, getHostEnvironment } from '@nimbalyst/runtime/host/hostEnvironment';
import { electronHostEnvironment, registerElectronHostEnvironment } from '../hostEnvironment';

afterEach(() => {
  setHostEnvironment(null);
  appMock.isPackaged = true;
});

describe('electron host environment', () => {
  it('answers both questions from Electron rather than the Node defaults', () => {
    expect(electronHostEnvironment.isPackaged()).toBe(true);
    expect(electronHostEnvironment.getAppPath()).toBe(
      '/Applications/Nimbalyst.app/Contents/Resources/app.asar',
    );
    expect(electronHostEnvironment.getAppPath()).not.toBe(process.cwd());
  });

  it('reads app lazily, so registering before app.whenReady() is safe', () => {
    appMock.isPackaged = false;
    expect(electronHostEnvironment.isPackaged()).toBe(false);
    appMock.isPackaged = true;
    expect(electronHostEnvironment.isPackaged()).toBe(true);
  });

  // bootstrap.ts calls this before it imports the main entry. If that call is
  // ever dropped the app boots on the Node default, silently reporting "not
  // packaged" and sending every binary-path lookup down the dev branch.
  it('installs itself into the runtime host slot', () => {
    expect(getHostEnvironment().isPackaged()).toBe(false); // Node default
    registerElectronHostEnvironment();
    expect(getHostEnvironment()).toBe(electronHostEnvironment);
    expect(getHostEnvironment().isPackaged()).toBe(true);
  });
});
