import type { ProviderCredentialVault } from "../credentials/ProviderCredentialVault";

/** Explicit project keys precede global aliases; subscription auth never acquires a key. */
export function resolveProviderApiKey(
  credentials: Pick<ProviderCredentialVault, "get">,
  provider: string,
  workspacePath?: string,
  claudeCodeAuthMethod = "login",
  extensionOwnsAuth = false
): string | undefined {
  if (provider === "claude-code" && claudeCodeAuthMethod !== "api-key")
    return undefined;
  if (
    extensionOwnsAuth ||
    provider === "lmstudio" ||
    provider === "antigravity-gemini-agent"
  )
    return "not-required";
  const override = workspacePath
    ? credentials.get(provider, { workspacePath })
    : undefined;
  return (
    override ?? credentials.get(provider === "claude" ? "anthropic" : provider)
  );
}
