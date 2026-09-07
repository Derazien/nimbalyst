// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Store from "../privateSettingsStore";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-settings-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const mode = (file: string) => fs.statSync(file).mode & 0o777;

it("keeps new and repaired files private across independent writers and unrelated saves", () => {
  const first = new Store({ cwd: dir, name: "ai-settings" });
  first.set("showToolCalls", false);
  expect(mode(first.path)).toBe(0o600);
  fs.chmodSync(first.path, 0o666);
  const second = new Store({ cwd: dir, name: "ai-settings" });
  expect(mode(second.path)).toBe(0o600);
  fs.chmodSync(first.path, 0o600);
  second.set("showToolCalls", true);
  first.set("showToolCalls", false);
  expect(mode(first.path)).toBe(0o600);
});

it("rejects legacy credential writes and stale snapshots after migration", () => {
  const store = new Store({ cwd: dir, name: "ai-settings" });
  expect(() => store.set("apiKeys.openai", "dummy-new-secret")).toThrow(
    "secure storage"
  );
  fs.writeFileSync(
    store.path,
    JSON.stringify({ apiKeys: { openai: "dummy-legacy" } })
  );
  store.set("showToolCalls", true);
  fs.writeFileSync(store.path, "{}");
  expect(() => {
    store.store = { apiKeys: { openai: "dummy-legacy" } };
  }).toThrow("secure storage");
});

it("refuses to follow a settings symlink or broaden a read-only owner mode", () => {
  const outside = path.join(dir, "other.json");
  fs.writeFileSync(outside, "{}", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(dir, "ai-settings.json"));
  expect(() => new Store({ cwd: dir, name: "ai-settings" })).toThrow();
  expect(fs.readFileSync(outside, "utf8")).toBe("{}");
  fs.unlinkSync(path.join(dir, "ai-settings.json"));
  const store = new Store({ cwd: dir, name: "ai-settings" });
  store.set("value", 1);
  fs.chmodSync(store.path, 0o400);
  expect(() => store.set("value", 2)).toThrow();
  expect(mode(store.path)).toBe(0o400);
});
