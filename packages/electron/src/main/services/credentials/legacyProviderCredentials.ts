import fs from "node:fs";
import path from "node:path";
import { hardenPrivateFile } from "../../utils/privateFile";

export interface LegacyCredential {
  name: string;
  workspacePath?: string;
  value: string;
  location: string[];
  remove(): void;
}

export const normalizeCredentialWorkspace = (workspace: string) =>
  path.normalize(workspace).replace(/[\\/]+$/, "") ||
  path.parse(workspace).root;

/** Visits only documented provider-key locations, never arbitrary user content. */
export function visitLegacyCredentials(
  name: string,
  document: Record<string, any>
): LegacyCredential[] {
  const found: LegacyCredential[] = [];
  if (name === "ai-settings") {
    for (const [key, value] of Object.entries(document.apiKeys ?? {})) {
      if (key === "lmstudio_url" || value == null) continue;
      if (typeof value !== "string")
        throw new Error("Invalid legacy provider credential");
      found.push({
        name: key,
        value,
        location: ["apiKeys", key],
        remove: () => {
          delete document.apiKeys[key];
        },
      });
    }
    for (const [provider, config] of Object.entries(
      document.providerSettings ?? {}
    )) {
      const item = config as { apiKey?: unknown };
      if (!item?.apiKey) continue;
      if (typeof item.apiKey !== "string")
        throw new Error("Invalid legacy provider credential");
      found.push({
        name: provider === "claude" ? "anthropic" : provider,
        value: item.apiKey,
        location: ["providerSettings", provider, "apiKey"],
        remove: () => {
          delete item.apiKey;
        },
      });
    }
  }
  if (name === "workspace-settings") {
    for (const [id, workspace] of Object.entries(document)) {
      if (!workspace || typeof workspace !== "object") continue;
      for (const [provider, config] of Object.entries(
        workspace.aiProviderOverrides?.providers ?? {}
      )) {
        const item = config as { apiKey?: unknown };
        if (!item?.apiKey) continue;
        if (typeof item.apiKey !== "string")
          throw new Error("Invalid legacy provider credential");
        const workspacePath =
          workspace.workspacePath ||
          (id.startsWith("ws:")
            ? Buffer.from(id.slice(3), "base64url").toString("utf8")
            : undefined);
        if (!workspacePath || !path.isAbsolute(workspacePath))
          throw new Error("Invalid legacy credential scope");
        found.push({
          name: provider,
          location: [
            id,
            "aiProviderOverrides",
            "providers",
            provider,
            "apiKey",
          ],
          workspacePath: normalizeCredentialWorkspace(workspacePath),
          value: item.apiKey,
          remove: () => {
            delete item.apiKey;
          },
        });
      }
    }
  }
  return found;
}

export function readLegacySettings(
  directory: string,
  name: string
): {
  file: string;
  data: Record<string, any>;
  credentials: LegacyCredential[];
} {
  const file = path.join(directory, `${name}.json`);
  if (hardenPrivateFile(file) === undefined)
    return { file, data: {}, credentials: [] };
  let data: Record<string, any>;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Legacy settings could not be read");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid legacy settings");
  return { file, data, credentials: visitLegacyCredentials(name, data) };
}
