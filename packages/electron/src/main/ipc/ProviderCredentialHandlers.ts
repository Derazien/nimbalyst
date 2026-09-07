import { safeHandle } from "../utils/ipcRegistry";
import { getProviderCredentials } from "../services/credentials/providerCredentials";
import { getSettingsService } from "../services/SettingsService";
import { isSettingKey } from "../../shared/settings/keys";
import type { CredentialScope } from "../../shared/providerCredentials";

export function registerProviderCredentialHandlers(): void {
  safeHandle("provider-credentials:list", () =>
    getProviderCredentials().snapshot()
  );
  safeHandle("provider-credentials:retry", () =>
    getProviderCredentials().snapshot()
  );
  safeHandle(
    "provider-credentials:set",
    (_event, name: string, value: string, scope: CredentialScope = {}) => {
      if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw new Error("Invalid credential scope");
      const key = `ai.apiKey.${name}`;
      if (typeof name !== "string" || name === "lmstudio_url")
        throw new Error("Invalid credential name");
      if (scope.workspacePath === undefined && isSettingKey(key))
        getSettingsService().set(key, value);
      else getProviderCredentials().set(name, value, scope);
      return getProviderCredentials().snapshot();
    }
  );
  safeHandle(
    "provider-credentials:delete",
    (_event, name: string, scope: CredentialScope = {}) => {
      if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw new Error("Invalid credential scope");
      const key = `ai.apiKey.${name}`;
      if (typeof name !== "string" || name === "lmstudio_url")
        throw new Error("Invalid credential name");
      if (scope.workspacePath === undefined && isSettingKey(key))
        getSettingsService().delete(key);
      else getProviderCredentials().delete(name, scope);
      return getProviderCredentials().snapshot();
    }
  );
}
