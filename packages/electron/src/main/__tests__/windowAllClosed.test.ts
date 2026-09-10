import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { quit, isReady, isKeepRunningInTray, info } = vi.hoisted(() => ({
  quit: vi.fn(),
  isReady: vi.fn(() => true),
  isKeepRunningInTray: vi.fn(() => false),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    quit: () => quit(),
    isReady: () => isReady(),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { main: { info, warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../utils/store', () => ({
  isKeepRunningInTray: () => isKeepRunningInTray(),
}));

import { createWindowAllClosedHandler } from '../windowAllClosed';

const realPlatform = process.platform;
const setPlatform = (platform: string) =>
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

/**
 * The handler with every input at its "a project window just closed" default.
 * Each test flips only the input it is about, so a behaviour change shows up as
 * one failing assertion rather than a rewritten fixture.
 */
function makeHandler(overrides: {
  isAppQuitting?: boolean;
  workspaceManagerManuallyClosed?: boolean;
} = {}) {
  const showWorkspaceManager = vi.fn();
  const handler = createWindowAllClosedHandler({
    isAppQuitting: () => overrides.isAppQuitting ?? false,
    wasWorkspaceManagerManuallyClosed: () => overrides.workspaceManagerManuallyClosed ?? false,
    showWorkspaceManager,
  });
  return { handler, showWorkspaceManager };
}

describe('createWindowAllClosedHandler', () => {
  beforeEach(() => {
    quit.mockReset();
    isReady.mockReset().mockReturnValue(true);
    isKeepRunningInTray.mockReset().mockReturnValue(false);
    info.mockReset();
    setPlatform('win32');
  });

  afterAll(() => setPlatform(realPlatform));

  it('quits when the user closes the last window and the tray setting is off', () => {
    isKeepRunningInTray.mockReturnValue(false);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: true });

    handler();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(showWorkspaceManager).not.toHaveBeenCalled();
  });

  it('keeps the process alive when the user closes the last window and the tray setting is on', () => {
    isKeepRunningInTray.mockReturnValue(true);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: true });

    handler();

    // Nothing quits and nothing is reopened: the tray icon is the only surface
    // left, and it is what brings the WorkspaceManager back.
    expect(quit).not.toHaveBeenCalled();
    expect(showWorkspaceManager).not.toHaveBeenCalled();
  });

  it('still quits when the app is already quitting, whatever the tray setting says', () => {
    // The dangerous failure: Quit from the menu closes every window, which fires
    // this handler. Reading the tray setting before the quitting flag would
    // strand a headless process the user asked to end.
    isKeepRunningInTray.mockReturnValue(true);
    const { handler } = makeHandler({ isAppQuitting: true, workspaceManagerManuallyClosed: true });

    handler();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('reopens the WorkspaceManager when a project window closes, tray setting on', () => {
    isKeepRunningInTray.mockReturnValue(true);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: false });

    handler();

    expect(showWorkspaceManager).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('reopens the WorkspaceManager when a project window closes, tray setting off', () => {
    isKeepRunningInTray.mockReturnValue(false);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: false });

    handler();

    expect(showWorkspaceManager).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('leaves macOS alone: no quit with the setting off, as before', () => {
    setPlatform('darwin');
    isKeepRunningInTray.mockReturnValue(false);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: true });

    handler();

    expect(quit).not.toHaveBeenCalled();
    expect(showWorkspaceManager).not.toHaveBeenCalled();
  });

  it('reads the manual-close flag exactly once per event', () => {
    // The flag resets itself on read, so a second call inside one event would
    // consume it and turn the next window close into an unwanted reopen.
    const wasWorkspaceManagerManuallyClosed = vi.fn(() => true);
    const handler = createWindowAllClosedHandler({
      isAppQuitting: () => false,
      wasWorkspaceManagerManuallyClosed,
      showWorkspaceManager: vi.fn(),
    });

    handler();

    expect(wasWorkspaceManagerManuallyClosed).toHaveBeenCalledTimes(1);
  });

  it('does not read the manual-close flag while the app is quitting', () => {
    const wasWorkspaceManagerManuallyClosed = vi.fn(() => true);
    const handler = createWindowAllClosedHandler({
      isAppQuitting: () => true,
      wasWorkspaceManagerManuallyClosed,
      showWorkspaceManager: vi.fn(),
    });

    handler();

    expect(wasWorkspaceManagerManuallyClosed).not.toHaveBeenCalled();
  });

  it('does not reopen the WorkspaceManager before the app is ready', () => {
    isReady.mockReturnValue(false);
    const { handler, showWorkspaceManager } = makeHandler({ workspaceManagerManuallyClosed: false });

    handler();

    expect(showWorkspaceManager).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});
