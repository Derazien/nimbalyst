export type CredentialScope = { workspacePath?: string };
export type CredentialStorageState =
  | "available"
  | "unavailable"
  | "migration-pending"
  | "unreadable";
export interface ProviderCredentialInfo extends CredentialScope {
  name: string;
  configured: boolean;
}
export interface ProviderCredentialSnapshot {
  state: CredentialStorageState;
  credentials: ProviderCredentialInfo[];
  message?: string;
}

/** UI-only marker. Secret writes must never accept it as a credential. */
export const SAVED_CREDENTIAL = "••••••••";
export const isProviderCredentialKey = (key: string) =>
  key.startsWith("ai.apiKey.") && key !== "ai.apiKey.lmstudio_url";

/** General settings views expose no credential-bearing provider config fields. */
export function withoutProviderConfigCredentials<T extends Record<string, any>>(
  configs: T
): T {
  return Object.fromEntries(
    Object.entries(configs).map(([id, config]) => {
      if (!config || typeof config !== "object") return [id, config];
      const { apiKey: _secret, ...settings } = config;
      return [id, settings];
    })
  ) as T;
}
