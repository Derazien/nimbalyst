import { app, safeStorage, BrowserWindow } from "electron";
import { ProviderCredentialVault } from "./ProviderCredentialVault";

let vault: ProviderCredentialVault | undefined;
export function isProviderEncryptionAvailable(
  storage: Pick<
    typeof safeStorage,
    "isEncryptionAvailable" | "getSelectedStorageBackend"
  >,
  platform: string,
  ready: boolean
): boolean {
  return (
    ready &&
    storage.isEncryptionAvailable() &&
    (platform !== "linux" ||
      storage.getSelectedStorageBackend() !== "basic_text")
  );
}
const subscribers = new Set<() => void>();
export function subscribeProviderCredentialChanges(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
function credentialsChanged(): void {
  for (const fn of subscribers) fn();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send("provider-credentials:changed");
  }
}
export function getProviderCredentials(): ProviderCredentialVault {
  return (vault ??= new ProviderCredentialVault(
    app.getPath("userData"),
    {
      available: () =>
        isProviderEncryptionAvailable(
          safeStorage,
          process.platform,
          app.isReady()
        ),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    credentialsChanged
  ));
}
