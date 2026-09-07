let installed = false;
export function installProviderCredentialListener(
  refresh: () => Promise<void>
): void {
  if (installed) return;
  window.electronAPI.on("provider-credentials:changed", () => {
    void refresh();
  });
  installed = true;
}
