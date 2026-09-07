import ElectronStore from "electron-store";
import { app } from "electron";
import path from "node:path";
import { assertPrivateFileWritable, hardenPrivateFile } from "./privateFile";
import {
  readLegacySettings,
  visitLegacyCredentials,
} from "../services/credentials/legacyProviderCredentials";
import { withCredentialLock } from "../services/credentials/credentialLock";

/** All app-owned settings use this boundary, including bootstrap readers. */
export default class PrivateSettingsStore<
  T extends Record<string, any> = Record<string, unknown>
> extends ElectronStore<T> {
  override get store(): T {
    return super.store;
  }
  override set store(value: T) {
    withCredentialLock(path.dirname(this.path), () => {
      super.store = value;
    });
  }
  constructor(options: ElectronStore.Options<T> = {}) {
    const cwd = options.cwd ?? app.getPath("userData");
    const name = options.name ?? "config";
    if (path.basename(name) !== name || name === "..")
      throw new Error("Invalid settings name");
    const file = path.join(cwd, `${name}.${options.fileExtension ?? "json"}`);
    hardenPrivateFile(file);
    const serialize =
      options.serialize ?? ((value: T) => JSON.stringify(value, null, "\t"));
    super({
      ...options,
      cwd,
      configFileMode: 0o600,
      serialize(value) {
        assertPrivateFileWritable(file);
        if (name === "ai-settings" || name === "workspace-settings") {
          const existing = readLegacySettings(cwd, name).credentials;
          // Only the verified vault migration may remove a pending legacy copy.
          // Metadata-only settings saves must not destroy it while storage is locked.
          for (const old of existing) {
            let target: Record<string, any> = value;
            for (const part of old.location.slice(0, -1))
              target = target[part] ??= {};
            const field = old.location[old.location.length - 1];
            if (target[field] === undefined) target[field] = old.value;
          }
          const incoming = visitLegacyCredentials(name, value);
          if (incoming.length) {
            if (
              incoming.some(
                (next) =>
                  !existing.some(
                    (old) =>
                      old.name === next.name &&
                      old.workspacePath === next.workspacePath &&
                      old.value === next.value
                  )
              )
            ) {
              throw new Error(
                "Provider credentials must be written through secure storage"
              );
            }
          }
        }
        return serialize(value);
      },
    });
  }
}

/** Repair dormant settings files too, before bootstrap opens any store. */
export function hardenExistingSettings(directory: string): void {
  for (const name of [
    "app-settings",
    "ai-settings",
    "workspace-settings",
    "nimbalyst-settings",
    "analytics-settings",
    "feature-usage",
    "feature-tracking",
    "logger-config",
    "terminal-store",
  ]) {
    hardenPrivateFile(path.join(directory, `${name}.json`));
  }
}
