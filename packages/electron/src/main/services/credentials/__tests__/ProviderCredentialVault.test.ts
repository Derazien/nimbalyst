// @vitest-environment node
import { resolveProviderApiKey } from "../../ai/resolveProviderApiKey";
import { isProviderEncryptionAvailable } from "../providerCredentials";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  ProviderCredentialVault,
  type CredentialEncryption,
} from "../ProviderCredentialVault";
import PrivateSettingsStore from "../../../utils/privateSettingsStore";
import { withCredentialLock } from "../credentialLock";

let dir: string;
let available: boolean;
let encryption: CredentialEncryption;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-vault-"));
  available = true;
  const key = randomBytes(32);
  encryption = {
    available: () => available,
    encrypt(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(value), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decrypt(value) {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        c.update(value.subarray(28)),
        c.final(),
      ]).toString();
    },
  };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const storeLegacy = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value), {
    mode: 0o666,
  });
const vault = () => new ProviderCredentialVault(dir, encryption);

it("migrates global, dynamic, and project keys, retains ordinary settings, and survives reopen/delete", () => {
  storeLegacy("ai-settings", {
    apiKeys: {
      openai: "dummy-global-secret",
      custom: "dummy-extension-secret",
      lmstudio_url: "http://localhost:1234",
    },
    showToolCalls: true,
  });
  storeLegacy("workspace-settings", {
    project: {
      workspacePath: "/project",
      aiProviderOverrides: {
        providers: {
          openai: { apiKey: "dummy-project-secret", enabled: false },
        },
      },
    },
  });
  expect(vault().get("openai")).toBe("dummy-global-secret");
  expect(vault().get("openai", { workspacePath: "/project/" })).toBe(
    "dummy-project-secret"
  );
  const json = fs.readFileSync(path.join(dir, "ai-settings.json"), "utf8");
  expect(json.includes("dummy-")).toBe(false);
  expect(JSON.parse(json)).toEqual({
    apiKeys: { lmstudio_url: "http://localhost:1234" },
    showToolCalls: true,
  });
  expect(
    fs
      .readFileSync(path.join(dir, "workspace-settings.json"), "utf8")
      .includes("dummy-")
  ).toBe(false);
  const bytes = fs.readFileSync(
    path.join(dir, "provider-credentials/vault.bin")
  );
  expect(bytes.includes(Buffer.from("dummy-"))).toBe(false);
  expect(JSON.stringify(vault().snapshot()).includes("dummy-")).toBe(false);
  vault().delete("openai");
  expect(vault().get("openai")).toBeUndefined();
  expect(vault().get("openai", { workspacePath: "/project" })).toBe(
    "dummy-project-secret"
  );
  expect(
    fs.statSync(path.join(dir, "provider-credentials/vault.bin")).mode & 0o777
  ).toBe(0o600);
});

it("pauses keys without destroying legacy data when storage is unavailable, then retries", () => {
  storeLegacy("ai-settings", { apiKeys: { openai: "dummy-pending-secret" } });
  available = false;
  expect(vault().snapshot().state).toBe("unavailable");
  expect(vault().availableKeys()).toEqual({});
  expect(() => vault().get("openai")).toThrow("paused");
  expect(() => vault().set("openai", "dummy-new")).toThrow("paused");
  expect(
    fs
      .readFileSync(path.join(dir, "ai-settings.json"), "utf8")
      .includes("dummy-pending-secret")
  ).toBe(true);
  expect(fs.statSync(path.join(dir, "ai-settings.json")).mode & 0o777).toBe(
    0o600
  );
  available = true;
  expect(vault().get("openai")).toBe("dummy-pending-secret");
});

it("preserves legacy data on encryption/read-back failures and resumes a verified partial migration", () => {
  storeLegacy("ai-settings", { apiKeys: { openai: "dummy-recoverable" } });
  const failed = new ProviderCredentialVault(dir, {
    ...encryption,
    encrypt: () => {
      throw new Error("failure");
    },
  });
  expect(failed.snapshot().state).toBe("unreadable");
  expect(
    fs
      .readFileSync(path.join(dir, "ai-settings.json"), "utf8")
      .includes("dummy-recoverable")
  ).toBe(true);
  const unreadable = new ProviderCredentialVault(dir, {
    ...encryption,
    decrypt: () => {
      throw new Error("failure");
    },
  });
  expect(unreadable.snapshot().state).toBe("unreadable");
  expect(
    fs
      .readFileSync(path.join(dir, "ai-settings.json"), "utf8")
      .includes("dummy-recoverable")
  ).toBe(true);
  expect(vault().get("openai")).toBe("dummy-recoverable");
  const failedReplacement = new ProviderCredentialVault(dir, {
    ...encryption,
    encrypt: () => Buffer.from("invalid-ciphertext"),
  });
  expect(() => failedReplacement.set("openai", "dummy-replacement")).toThrow();
  expect(vault().get("openai")).toBe("dummy-recoverable");
});

it("never overwrites a corrupt vault or resurrects a cleared key from restored settings", () => {
  expect(vault().mobileOpenAIKey()).toBeUndefined();
  vault().set("openai", "dummy-original");
  vault().delete("openai");
  expect(vault().mobileOpenAIKey()).toBe("");
  storeLegacy("ai-settings", { apiKeys: { openai: "dummy-original" } });
  expect(vault().snapshot().state).toBe("migration-pending");
  vault().delete("openai");
  expect(vault().get("openai")).toBeUndefined();
  const file = path.join(dir, "provider-credentials/vault.bin");
  fs.writeFileSync(file, "corrupt");
  expect(() => vault().set("openai", "dummy-replacement")).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("corrupt");
});

it("checks availability after caching, rejects malformed writes, and serializes profile writers", () => {
  const current = vault();
  current.set("openai", "dummy-retained");
  expect(current.get("openai")).toBe("dummy-retained");
  available = false;
  expect(current.availableKeys()).toEqual({});
  available = true;
  expect(() => current.delete({} as string)).toThrow("Invalid");
  expect(() =>
    current.set("openai", "dummy-new", { workspacePath: "" })
  ).toThrow();
  withCredentialLock(dir, () => {
    expect(() => vault().set("openai", "dummy-concurrent")).toThrow("busy");
  });
  expect(current.get("openai")).toBe("dummy-retained");
});

it("leaves a symlinked vault directory untouched and retains keys if source cleanup fails", () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "vault-target-"));
  try {
    fs.writeFileSync(path.join(external, "vault.bin"), "untouched");
    fs.chmodSync(path.join(external, "vault.bin"), 0o666);
    fs.symlinkSync(external, path.join(dir, "provider-credentials"));
    expect(vault().snapshot().state).toBe("unreadable");
    expect(fs.statSync(path.join(external, "vault.bin")).mode & 0o777).toBe(
      0o666
    );
    fs.unlinkSync(path.join(dir, "provider-credentials"));
  } finally {
    fs.rmSync(external, { recursive: true });
  }
  storeLegacy("ai-settings", { apiKeys: { openai: "dummy-retry" } });
  fs.chmodSync(path.join(dir, "ai-settings.json"), 0o400);
  expect(vault().snapshot().state).toBe("migration-pending");
  expect(
    fs
      .readFileSync(path.join(dir, "ai-settings.json"), "utf8")
      .includes("dummy-retry")
  ).toBe(true);
  fs.chmodSync(path.join(dir, "ai-settings.json"), 0o600);
  expect(vault().get("openai")).toBe("dummy-retry");
});

it("requires a real OS encryption backend and Electron readiness", () => {
  const basic = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text" as const,
  };
  expect(isProviderEncryptionAvailable(basic, "linux", true)).toBe(false);
  expect(isProviderEncryptionAvailable(basic, "darwin", false)).toBe(false);
  expect(
    isProviderEncryptionAvailable(
      { ...basic, getSelectedStorageBackend: () => "gnome_libsecret" },
      "linux",
      true
    )
  ).toBe(true);
});

it("keeps OAuth without a saved key usable when locked, but pauses global and project key authentication after reopen", () => {
  vault().set("openai", "dummy-voice-key");
  available = false;
  expect(vault().get("openai-codex")).toBeUndefined();
  expect(() => vault().get("openai")).toThrow("paused");
  expect(vault().snapshot().credentials).toContainEqual({
    name: "openai",
    configured: true,
  });
  available = true;
  vault().set("openai-codex", "dummy-project-key", {
    workspacePath: "/project",
  });
  available = false;
  expect(vault().get("openai-codex")).toBeUndefined();
  expect(() =>
    vault().get("openai-codex", { workspacePath: "/project" })
  ).toThrow("paused");
  fs.writeFileSync(path.join(dir, "provider-credentials/vault.bin"), "invalid");
  expect(() => vault().get("openai-codex")).toThrow();
});

it("resolves provider aliases and project keys without changing subscription selection", () => {
  const credentials = vault();
  credentials.set("anthropic", "dummy-chat");
  credentials.set("claude-code", "dummy-code");
  credentials.set("openai-codex", "dummy-codex");
  credentials.set("openai-codex", "dummy-project", {
    workspacePath: "/project",
  });
  expect(resolveProviderApiKey(credentials, "claude")).toBe("dummy-chat");
  expect(resolveProviderApiKey(credentials, "claude-code")).toBeUndefined();
  expect(
    resolveProviderApiKey(credentials, "claude-code", undefined, "api-key")
  ).toBe("dummy-code");
  expect(resolveProviderApiKey(credentials, "openai-codex", "/project")).toBe(
    "dummy-project"
  );
  credentials.delete("openai-codex", { workspacePath: "/project" });
  expect(resolveProviderApiKey(credentials, "openai-codex", "/project")).toBe(
    "dummy-codex"
  );
  available = false;
  expect(resolveProviderApiKey(credentials, "claude-code")).toBeUndefined();
  expect(resolveProviderApiKey(credentials, "lmstudio")).toBe("not-required");
  expect(
    resolveProviderApiKey(credentials, "dynamic", undefined, undefined, true)
  ).toBe("not-required");
  expect(() =>
    resolveProviderApiKey(credentials, "claude-code", undefined, "api-key")
  ).toThrow("paused");
});

it("migrates legacy provider-config keys and preserves their only copy during locked metadata saves", () => {
  storeLegacy("ai-settings", {
    providerSettings: {
      claude: { enabled: false, apiKey: "dummy-config-key" },
    },
  });
  available = false;
  const settings = new PrivateSettingsStore({ name: "ai-settings", cwd: dir });
  settings.set("providerSettings.claude", { enabled: true });
  expect(
    JSON.parse(fs.readFileSync(settings.path, "utf8")).providerSettings.claude
      .apiKey
  ).toBe("dummy-config-key");
  expect(() =>
    settings.set("providerSettings.claude", {
      enabled: true,
      apiKey: "dummy-new",
    })
  ).toThrow("secure storage");
  available = true;
  expect(vault().get("anthropic")).toBe("dummy-config-key");
  expect(
    JSON.parse(fs.readFileSync(settings.path, "utf8")).providerSettings.claude
  ).toEqual({ enabled: true });
});

it("retains the prior credential and cleans encrypted temporary files after publication fails", () => {
  vault().set("openai", "dummy-prior");
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("simulated publication failure");
  });
  try {
    expect(() => vault().set("openai", "dummy-next")).toThrow();
  } finally {
    rename.mockRestore();
  }
  expect(vault().get("openai")).toBe("dummy-prior");
  expect(fs.readdirSync(path.join(dir, "provider-credentials"))).toEqual([
    "vault.bin",
  ]);
});


it('moves project credentials without plaintext and refuses to overwrite another project key', () => {
  vault().set('openai', 'dummy-project', {workspacePath: '/old'});
  vault().moveWorkspace('/old', '/new');
  expect(vault().get('openai', {workspacePath: '/old'})).toBeUndefined();
  expect(vault().get('openai', {workspacePath: '/new'})).toBe('dummy-project');
  vault().set('openai', 'dummy-conflict', {workspacePath: '/other'});
  expect(() => vault().moveWorkspace('/new', '/other')).toThrow('migration');
  expect(vault().get('openai', {workspacePath: '/new'})).toBe('dummy-project');
});
