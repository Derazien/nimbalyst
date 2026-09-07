import { atom } from "jotai";
import { store } from "@nimbalyst/runtime/store";
import type {
  CredentialScope,
  ProviderCredentialSnapshot,
} from "../../shared/providerCredentials";

export const providerCredentialsAtom = atom<ProviderCredentialSnapshot | null>(
  null
);
export const providerCredentialErrorAtom = atom<string | null>(null);
import { installProviderCredentialListener } from "./listeners/providerCredentialListeners";
export async function refreshProviderCredentials(): Promise<void> {
  installProviderCredentialListener(refreshProviderCredentials);
  try {
    const result = (await window.electronAPI.invoke(
      "provider-credentials:list"
    )) as ProviderCredentialSnapshot;
    store.set(providerCredentialsAtom, result);
  } catch {
    store.set(
      providerCredentialErrorAtom,
      "Could not load saved API keys. Retry when secure storage is available."
    );
  }
}

export async function changeProviderCredential(
  name: string,
  value: string | null,
  scope: CredentialScope = {}
): Promise<void> {
  store.set(providerCredentialErrorAtom, null);
  try {
    const result = (await window.electronAPI.invoke(
      value === null || value === ""
        ? "provider-credentials:delete"
        : "provider-credentials:set",
      ...(value === null || value === "" ? [name, scope] : [name, value, scope])
    )) as ProviderCredentialSnapshot;
    store.set(providerCredentialsAtom, result);
  } catch {
    const message =
      "Could not confirm the API key change. Unlock secure storage, refresh, and retry.";
    store.set(providerCredentialErrorAtom, message);
    throw new Error(message);
  }
}
