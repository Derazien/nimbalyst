import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Each isolated test module owns its Electron profile, including transitive stores.
const directory = mkdtempSync(join(tmpdir(), "nimbalyst-test-profile-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
export const testApp = {
  getPath: vi.fn(() => directory),
  getName: vi.fn(() => "test-app"),
  getVersion: vi.fn(() => "1.0.0"),
  isReady: vi.fn(() => true),
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
};
