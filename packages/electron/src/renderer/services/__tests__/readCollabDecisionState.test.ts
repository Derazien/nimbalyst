// @vitest-environment node
import * as Y from "yjs";
import { beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ acquire: vi.fn(), export: vi.fn() }));
vi.mock("../HeadlessCollabDocument", () => ({
  acquireHeadlessCollabDocument: host.acquire,
  assertDecodable: (resource: any) => {
    if (resource.undecoded) throw new Error("Cannot decode");
  },
  requireCollabCodec: () => ({}),
  projectCollabDocContent: host.export,
  HeadlessCollabDocumentError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));
import {
  readCollabDocWithDecisionState,
  snapshotCollabDecisions,
} from "../readCollabDecisionState";
const authority = { loaded: true, privacyVersion: 1 as const };

function fixture() {
  const doc = new Y.Doc();
  const node = new Y.XmlElement();
  node.setAttribute("__type", "decision");
  node.setAttribute("__content", "id: dcn-live\nask: Ship?\ntype: confirm");
  doc.get("root", Y.XmlText).insertEmbed(0, node);
  doc.getMap("decisions").set("dcn-live\x1falice", {
    answer: { type: "confirm", value: true, secret: "omit" },
    voterName: "Alice",
    at: 1,
  });
  doc.getMap("decisions").set("dcn-deleted\x1fbob", {
    answer: { type: "confirm", value: false },
    at: 2,
  });
  doc.getMap("decisionRecommendations").set("dcn-live\x1fagent", {
    answer: { type: "confirm", value: false },
    at: 3,
    rationale: "Review first",
    secret: "omit",
  });
  return doc;
}
beforeEach(() => {
  host.acquire.mockReset();
  host.export.mockReset().mockReturnValue("editable source");
});
it("reads actual hydrated Yjs answers separately, filters deleted blocks and private metadata", () => {
  const source = fixture();
  const hydrated = new Y.Doc();
  Y.applyUpdate(hydrated, Y.encodeStateAsUpdate(source));
  const state = snapshotCollabDecisions(hydrated);
  expect(state).toEqual({
    readOnly: true,
    truncated: false,
    blocks: [
      {
        blockId: "dcn-live",
        humanVotes: [
          {
            voterId: "alice",
            voterName: "Alice",
            answer: { type: "confirm", value: true },
            at: 1,
          },
        ],
        agentRecommendations: [
          {
            agentId: "agent",
            answer: { type: "confirm", value: false },
            rationale: "Review first",
            at: 3,
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(state)).not.toContain("secret");
  source.destroy();
  hydrated.destroy();
});
it("bounds text and total output and reports truncation", () => {
  const doc = fixture();
  for (let i = 0; i < 150; i++)
    doc.getMap("decisions").set(`dcn-live\x1fmember${i}`, {
      answer: { type: "editText", text: "x".repeat(10000), edited: true },
      at: i,
    });
  const state = snapshotCollabDecisions(doc);
  expect(state.truncated).toBe(true);
  expect(JSON.stringify(state).length).toBeLessThan(66000);
  doc.destroy();
});
it("uses the authenticated acquisition, returns source and snapshot, and releases", async () => {
  const doc = fixture(),
    release = vi.fn();
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [] }),
    },
    release,
  });
  const result = await readCollabDocWithDecisionState(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(host.acquire).toHaveBeenCalledWith(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(result.content).toBe("editable source");
  expect(result.decisionState.blocks[0].humanVotes).toHaveLength(1);
  expect(release).toHaveBeenCalledOnce();
  doc.destroy();
});
it("propagates authorization failure without exposing cached answers", async () => {
  host.acquire.mockRejectedValue(new Error("No team JWT"));
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
  ).rejects.toThrow("No team JWT");
  expect(host.export).not.toHaveBeenCalled();
});
it("releases after undecodable content and export failures", async () => {
  const doc = fixture(),
    release = vi.fn();
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [] }),
    },
    release,
    undecoded: true,
  });
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
  ).rejects.toThrow("Cannot decode");
  expect(release).toHaveBeenCalledOnce();
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [] }),
    },
    release,
  });
  host.export.mockImplementation(() => {
    throw new Error("Codec failed");
  });
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
  ).rejects.toThrow("Codec failed");
  expect(release).toHaveBeenCalledTimes(2);
  doc.destroy();
});
it("does not attribute answers to duplicated or deleted block identities", () => {
  const doc = fixture();
  const duplicate = new Y.XmlElement();
  duplicate.setAttribute("__type", "decision");
  duplicate.setAttribute(
    "__content",
    "id: dcn-live\nask: Different question?\ntype: confirm"
  );
  doc.get("root", Y.XmlText).insertEmbed(1, duplicate);
  expect(snapshotCollabDecisions(doc).blocks).toEqual([]);
  doc.get("root", Y.XmlText).delete(0, 2);
  expect(snapshotCollabDecisions(doc).blocks).toEqual([]);
  doc.destroy();
});
it("refuses a missing workspace without attempting acquisition", async () => {
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", undefined)
  ).rejects.toThrow("No workspace");
  expect(host.acquire).not.toHaveBeenCalled();
});

it("omits historical hidden Yjs answers and uses authorized private responses even when YAML says open", () => {
  const doc = fixture();
  const node = doc.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlElement;
  node.setAttribute(
    "__content",
    "id: dcn-live\nask: Ship?\ntype: confirm\nvisibility: hiddenUntilAnswered"
  );
  expect(snapshotCollabDecisions(doc).blocks[0].humanVotes).toEqual([]);
  node.setAttribute(
    "__content",
    "id: dcn-live\nask: Ship?\ntype: confirm\nvisibility: open"
  );
  const state = {
    blockId: "dcn-live",
    recipientIds: ["bob"],
    sentAt: 1,
    sentBy: "author",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateResponses: { votes: [], canSeeAll: false, responseVersion: 0 },
  };
  expect(snapshotCollabDecisions(doc, [state]).blocks[0].humanVotes).toEqual(
    []
  );
  doc.destroy();
});

it("reads authorized private projection and sanitizes sealed ballot details without changing the live document", async () => {
  const doc = fixture(),
    release = vi.fn();
  const node = doc.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlElement;
  const original =
    "id: dcn-live\nask: Ship?\ntype: confirm\nvisibility: open\nresolved: true\nvotes:\n - Alice: PRIVATE_SECRET\nresolvedFrom: alice\nnotes: PRIVATE_NOTES";
  node.setAttribute("__content", original);
  const requestDecision = vi.fn().mockResolvedValue({
    ...authority,
    decisions: [
      {
        blockId: "dcn-live",
        privateResponses: {
          votes: [
            {
              voterId: "anonymous-1",
              answer: { type: "confirm", value: true },
              at: 0,
            },
          ],
          canSeeAll: true,
          responseVersion: 1,
        },
      },
    ],
  });
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: { requestDecision },
    release,
  });
  host.export.mockImplementation((_codec, projected: Y.Doc) =>
    (
      projected.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlElement
    ).getAttribute("__content")
  );
  const result = await readCollabDocWithDecisionState(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(requestDecision).toHaveBeenCalledWith({ operation: "list" });
  expect(result.content).not.toContain("PRIVATE_SECRET");
  expect(result.content).not.toContain("PRIVATE_NOTES");
  expect(result.content).not.toContain("resolvedFrom");
  expect(result.decisionState.blocks[0].humanVotes).toEqual([
    { voterId: "anonymous-1", answer: { type: "confirm", value: true }, at: 0 },
  ]);
  expect(node.getAttribute("__content")).toBe(original);
  expect(release).toHaveBeenCalledOnce();
  doc.destroy();
});

it("returns the authorized own answer separately while other answers remain locked", () => {
  const doc = fixture();
  const myVote = {
    voterId: "bob",
    answer: { type: "confirm" as const, value: true },
    at: 1,
    note: "own note",
  };
  const state = {
    blockId: "dcn-live",
    recipientIds: ["bob"],
    sentAt: 1,
    sentBy: "author",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateResponses: {
      votes: [],
      myVote,
      canSeeAll: false,
      responseVersion: 1,
    },
  };
  const block = snapshotCollabDecisions(doc, [state]).blocks[0];
  expect(block.humanVotes).toEqual([]);
  expect(block.myVote).toEqual(myVote);
  expect(block.canSeeAll).toBe(false);
  doc.destroy();
});

it("refuses unavailable or rejected private state without exporting cached document data", async () => {
  const doc = fixture(),
    release = vi.fn();
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {},
    release,
  });
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
  ).rejects.toThrow("Authorized decision state");
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {
      requestDecision: vi.fn().mockRejectedValue(new Error("Access denied")),
    },
    release,
  });
  await expect(
    readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
  ).rejects.toThrow("Access denied");
  expect(host.export).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
  doc.destroy();
});

it("preserves attributed public agent recommendations independently of private human visibility", () => {
  const doc = fixture();
  for (const canSeeAll of [false, true]) {
    const state = {
      blockId: "dcn-live",
      recipientIds: ["bob"],
      sentAt: 1,
      sentBy: "author",
      quorum: 1,
      answeredIds: [],
      sealed: false,
      privateResponses: { votes: [], canSeeAll, responseVersion: 0 },
    };
    const block = snapshotCollabDecisions(doc, [state]).blocks[0];
    expect(block.humanVotes).toEqual([]);
    expect(block.agentRecommendations).toEqual([
      {
        agentId: "agent",
        answer: { type: "confirm", value: false },
        at: 3,
        rationale: "Review first",
      },
    ]);
    expect(JSON.stringify(block)).not.toContain("secret");
  }
  doc.destroy();
});

it("rejects unsupported or unloaded authority before exporting markdown or supplemental raw votes", async () => {
  const doc = fixture(),
    release = vi.fn();
  for (const status of [
    {},
    { loaded: true },
    { loaded: false, privacyVersion: 1 },
  ]) {
    host.acquire.mockResolvedValue({
      yDoc: doc,
      documentType: "markdown",
      syncProvider: {
        requestDecision: vi
          .fn()
          .mockResolvedValue({ decisions: [], ...status }),
      },
      release,
    });
    await expect(
      readCollabDocWithDecisionState("collab://org:o:doc:d", "/workspace")
    ).rejects.toThrow("Authorized decision state");
  }
  expect(host.export).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(3);
  doc.destroy();
});

it("sanitizes a changed-open unsent private group sibling while retaining public agent opinions and the live replica", async () => {
  const doc = fixture(),
    release = vi.fn();
  const node = doc.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlElement;
  const original =
    "id: dcn-live\nask: Ship?\ntype: confirm\nvisibility: open\nresolved: true\nvotes:\n - Alice: PRIVATE_BALLOT\nnotes: PRIVATE_NOTE\nresolvedFrom: PRIVATE_PERSON\nscore: PRIVATE_SCORE\ndistribution: PRIVATE_DISTRIBUTION";
  node.setAttribute("__content", original);
  const group = {
    blockId: "dcn-first",
    recipientIds: [],
    sentAt: 1,
    sentBy: "author",
    quorum: 1,
    answeredIds: [],
    sealed: false,
    privateGroupBlockIds: ["dcn-first", "dcn-live"],
  };
  const snapshot = snapshotCollabDecisions(doc, [group]);
  expect(snapshot.blocks[0].humanVotes).toEqual([]);
  expect(snapshot.blocks[0].canSeeAll).toBe(false);
  expect(snapshot.blocks[0].agentRecommendations).toHaveLength(1);
  host.acquire.mockResolvedValue({
    yDoc: doc,
    documentType: "markdown",
    syncProvider: {
      requestDecision: vi
        .fn()
        .mockResolvedValue({ ...authority, decisions: [group] }),
    },
    release,
  });
  host.export.mockImplementation((_codec, projected: Y.Doc) =>
    (
      projected.get("root", Y.XmlText).toDelta()[0].insert as Y.XmlElement
    ).getAttribute("__content")
  );
  const result = await readCollabDocWithDecisionState(
    "collab://org:o:doc:d",
    "/workspace"
  );
  expect(result.content).not.toContain("PRIVATE_");
  expect(result.content).toContain("resolved: true");
  expect(result.decisionState.blocks[0].humanVotes).toEqual([]);
  expect(result.decisionState.blocks[0].agentRecommendations).toHaveLength(1);
  expect(node.getAttribute("__content")).toBe(original);
  expect(doc.getMap("decisions").size).toBe(2);
  expect(release).toHaveBeenCalledOnce();
  doc.destroy();
});
