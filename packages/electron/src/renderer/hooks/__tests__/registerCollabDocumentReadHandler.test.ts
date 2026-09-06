// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const readers = vi.hoisted(() => ({
  protected: vi.fn(async () => ({
    content: "outcome only",
    decisionState: { readOnly: true, blocks: [] },
  })),
  raw: vi.fn(async () => ({ content: "PRIVATE_SENTINEL", route: "mounted" })),
}));
vi.mock("../../services/readCollabDecisionState", () => ({
  readCollabDocWithDecisionState: readers.protected,
}));
vi.mock("../../services/agentDocumentAccess", () => ({
  readCollabDocForAgent: readers.raw,
}));
vi.mock("../../services/HeadlessCollabDocument", () => ({
  HeadlessCollabDocumentError: class extends Error {},
}));
import { registerCollabDocumentReadHandler } from "../registerCollabDocumentReadHandler";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("applies the authorized privacy reader to ordinary and supplemental MCP reads", async () => {
  let read!: (request: any) => Promise<void>;
  const send = vi.fn();
  vi.stubGlobal("window", {
    electronAPI: {
      onMcpReadCollabDoc: (callback: typeof read) => {
        read = callback;
        return () => {};
      },
      sendMcpReadCollabDocResult: send,
    },
  });
  registerCollabDocumentReadHandler(() => "/workspace");
  await read({
    targetFilePath: "collab://org:o:doc:d",
    resultChannel: "plain",
  });
  expect(readers.protected).toHaveBeenCalledWith(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(readers.raw).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith("plain", {
    success: true,
    content: "outcome only",
  });
  await read({
    targetFilePath: "collab://org:o:doc:d",
    resultChannel: "snapshot",
    includeDecisionState: true,
  });
  expect(send).toHaveBeenLastCalledWith("snapshot", {
    success: true,
    content: "outcome only",
    decisionState: { readOnly: true, blocks: [] },
  });
});
