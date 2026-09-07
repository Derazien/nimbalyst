import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const { change, cancel } = vi.hoisted(() => ({
  change: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
}));
vi.mock("../../../../store/providerCredentials", async () => {
  const { atom } = await import("jotai");
  return {
    providerCredentialsAtom: atom({
      state: "available",
      credentials: [
        { name: "openai", configured: true },
        { name: "removed-extension", configured: true },
      ],
    }),
    providerCredentialErrorAtom: atom(null),
    refreshProviderCredentials: vi.fn(),
    changeProviderCredential: change,
  };
});
vi.mock("../../../../store/atoms/appSettings", () => ({
  cancelPendingProviderKey: cancel,
  flushPendingAIProviderPersist: vi.fn(),
}));
import { ProviderCredentialsPanel } from "../ProviderCredentialsPanel";

it("clears a saved key without enabling a provider and cancels any queued key edit", async () => {
  render(<ProviderCredentialsPanel name="openai" compact />);
  fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith("openai", null, {
      workspacePath: undefined,
    })
  );
  expect(cancel).toHaveBeenCalledWith("openai");
  expect(screen.queryByText(/removed-extension/)).toBeNull();
});

it("keeps credentials for removed providers reachable in the full list", () => {
  render(<ProviderCredentialsPanel />);
  expect(screen.getByText("removed-extension — API key saved")).toBeDefined();
});
