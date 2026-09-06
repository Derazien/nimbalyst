import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocumentDecisionDeliveryState } from "@nimbalyst/collab-protocol";
import { DecisionsProvider, useDecisionVotes } from "../DecisionsContext";
import type { DecisionsConfig } from "../types";
import { parseDecisionFence } from "../../plugins/DecisionPlugin/decisionFence";

const authority = { loaded: true, privacyVersion: 1 as const };

const privateState: DocumentDecisionDeliveryState = {
  blockId: "dcn-private",
  recipientIds: ["alice", "bob"],
  sentAt: 1,
  sentBy: "alice",
  quorum: 2,
  answeredIds: [],
  sealed: false,
  privateResponses: { votes: [], canSeeAll: false, responseVersion: 3 },
};
const fence =
  "id: dcn-private\nask: Ship?\ntype: confirm\nvisibility: hiddenUntilAnswered";
function Probe({ content = fence }: { content?: string }) {
  const voting = useDecisionVotes(parseDecisionFence(content)!);
  return (
    <>
      <button
        onClick={() =>
          voting.castVote({ type: "confirm", value: true }, "my note")
        }
      >
        Answer
      </button>
      <button onClick={() => voting.retractVote()}>Retract</button>
      <output>
        {JSON.stringify({
          votes: voting.votes,
          recommendations: voting.recommendations,
          mine: voting.myVote,
          canVote: voting.canVote,
          canSeal: voting.canSeal,
          privateMode: voting.privateMode,
          tally: voting.canSeeAll,
          pending: voting.pending,
          error: voting.error,
        })}
      </output>
    </>
  );
}
function snapshot() {
  return JSON.parse(screen.getByRole("status").textContent!);
}

it("requires acknowledged Send and never writes hidden votes through unsupported or unsent hosts", async () => {
  const doc = new Y.Doc();
  const config: DecisionsConfig = {
    getYDoc: () => doc,
    currentUser: { id: "bob", name: "Bob" },
  };
  const view = render(
    <DecisionsProvider config={config}>
      <Probe />
    </DecisionsProvider>
  );
  fireEvent.click(screen.getByText("Answer"));
  expect(doc.getMap("decisions").size).toBe(0);
  expect(snapshot().canVote).toBe(false);
  const requestDecision = vi
    .fn()
    .mockResolvedValue({ ...authority, decisions: [] });
  view.rerender(
    <DecisionsProvider config={{ ...config, requestDecision }}>
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() =>
    expect(requestDecision).toHaveBeenCalledWith({ operation: "list" })
  );
  fireEvent.click(screen.getByText("Answer"));
  expect(requestDecision).toHaveBeenCalledTimes(1);
  expect(doc.getMap("decisions").size).toBe(0);
});

it("uses private response versions, keeps pending and failure explicit, and never falls back to Yjs", async () => {
  const doc = new Y.Doc();
  let rejectAnswer!: (error: Error) => void;
  const requestDecision = vi.fn().mockImplementation(async (command) => {
    if (command.operation === "list")
      return { ...authority, decisions: [privateState] };
    return new Promise((_resolve, reject) => {
      rejectAnswer = reject;
    });
  });
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
      }}
    >
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().canVote).toBe(true));
  fireEvent.click(screen.getByText("Answer"));
  expect(requestDecision).toHaveBeenLastCalledWith({
    operation: "answer",
    blockId: "dcn-private",
    answer: { type: "confirm", value: true },
    note: "my note",
    expectedVersion: 3,
  });
  expect(snapshot().pending).toBe(true);
  fireEvent.click(screen.getByText("Retract"));
  expect(requestDecision).toHaveBeenCalledTimes(2);
  await act(async () =>
    rejectAnswer(new Error("Answer version changed. Refresh and try again."))
  );
  expect(snapshot().error).toContain("version changed");
  expect(snapshot().pending).toBe(false);
  expect(doc.getMap("decisions").size).toBe(0);
});

it("honors pinned private state after YAML changes to open, uses own answer separately, and obeys server reveal", async () => {
  const doc = new Y.Doc();
  doc.getMap("decisions").set("dcn-private\x1falice", {
    answer: { type: "confirm", value: false },
    voterName: "RAW_SECRET",
    at: 1,
  });
  const myVote = {
    voterId: "bob",
    answer: { type: "confirm" as const, value: true },
    at: 2,
  };
  const state = {
    ...privateState,
    privateResponses: {
      votes: [],
      myVote,
      canSeeAll: false,
      responseVersion: 4,
    },
  };
  let publish!: (states: DocumentDecisionDeliveryState[]) => void;
  const requestDecision = vi
    .fn()
    .mockResolvedValue({ ...authority, decisions: [state] });
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
        onDecisionState: (listener) => {
          publish = (states) => listener(states, authority);
          return () => {};
        },
      }}
    >
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().mine?.voterId).toBe("bob"));
  expect(snapshot().votes).toEqual([]);
  expect(snapshot().tally).toBe(false);
  act(() =>
    publish([
      {
        ...state,
        privateResponses: {
          ...state.privateResponses,
          canSeeAll: true,
          votes: [{ ...myVote, voterId: "anonymous-1" }],
        },
      },
    ])
  );
  expect(snapshot().votes).toHaveLength(1);
  expect(snapshot().tally).toBe(true);
  await act(async () => fireEvent.click(screen.getByText("Retract")));
  expect(requestDecision).toHaveBeenLastCalledWith({
    operation: "retract",
    blockId: "dcn-private",
    expectedVersion: 4,
  });
  expect(doc.getMap("decisions").size).toBe(1);
});

it("withholds edited-open raw state until authorization loads and drops private data on host changes", async () => {
  const doc = new Y.Doc();
  doc.getMap("decisions").set("dcn-private\x1falice", {
    answer: { type: "confirm", value: true },
    voterName: "RAW_SECRET",
    at: 1,
  });
  let resolveOld!: (
    result: import("@nimbalyst/collab-protocol").DocumentDecisionResult
  ) => void;
  const requestDecision = vi.fn(
    () =>
      new Promise<import("@nimbalyst/collab-protocol").DocumentDecisionResult>(
        (resolve) => {
          resolveOld = resolve;
        }
      )
  );
  const config: DecisionsConfig = {
    getYDoc: () => doc,
    currentUser: { id: "bob", name: "Bob" },
    requestDecision,
  };
  const view = render(
    <DecisionsProvider config={config}>
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  expect(snapshot().votes).toEqual([]);
  expect(snapshot().canVote).toBe(false);
  fireEvent.click(screen.getByText("Answer"));
  expect(doc.getMap("decisions").size).toBe(1);
  const own = {
    voterId: "bob",
    answer: { type: "confirm" as const, value: true },
    at: 1,
  };
  const otherHost = {
    ...config,
    currentUser: { id: "carol", name: "Carol" },
    requestDecision: vi.fn().mockRejectedValue(new Error("Access denied")),
  };
  view.rerender(
    <DecisionsProvider config={otherHost}>
      <Probe />
    </DecisionsProvider>
  );
  await act(async () =>
    resolveOld({
      ...authority,
      decisions: [
        {
          ...privateState,
          privateResponses: { ...privateState.privateResponses!, myVote: own },
        },
      ],
    })
  );
  expect(snapshot().mine).toBeUndefined();
  expect(snapshot().votes).toEqual([]);
  expect(snapshot().canVote).toBe(false);
});

it("relocks a previously revealed projection on invalidation without falling back to stale Yjs", async () => {
  const doc = new Y.Doc();
  const own = {
    voterId: "bob",
    answer: { type: "confirm" as const, value: true },
    at: 1,
  };
  const state = {
    ...privateState,
    privateResponses: {
      votes: [{ ...own, voterId: "anonymous-1" }],
      myVote: own,
      canSeeAll: true,
      responseVersion: 1,
    },
  };
  let publish!: (states: DocumentDecisionDeliveryState[]) => void;
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision: vi
          .fn()
          .mockResolvedValue({ ...authority, decisions: [state] }),
        onDecisionState: (listener) => {
          publish = (states) => listener(states, authority);
          return () => {};
        },
      }}
    >
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().tally).toBe(true));
  act(() =>
    publish([
      {
        ...state,
        privateResponses: {
          votes: [],
          myVote: own,
          canSeeAll: false,
          responseVersion: 1,
        },
      },
    ])
  );
  expect(snapshot().tally).toBe(false);
  expect(snapshot().votes).toEqual([]);
  act(() => publish([]));
  expect(snapshot().mine).toBeUndefined();
  expect(snapshot().canVote).toBe(false);
});

it("keeps public attributed recommendations separate while private human results are locked and unlocked", async () => {
  const doc = new Y.Doc();
  const recommendation = {
    agentId: "agent-1",
    agentName: "Reviewer",
    answer: { type: "confirm", value: false },
    rationale: "Public opinion",
    at: 1,
  };
  doc
    .getMap("decisionRecommendations")
    .set("dcn-private\x1fagent-1", recommendation);
  let publish!: (states: DocumentDecisionDeliveryState[]) => void;
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision: vi
          .fn()
          .mockResolvedValue({ ...authority, decisions: [privateState] }),
        onDecisionState: (listener) => {
          publish = (states) => listener(states, authority);
          return () => {};
        },
      }}
    >
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().canVote).toBe(true));
  expect(snapshot().recommendations).toEqual([recommendation]);
  expect(snapshot().votes).toEqual([]);
  act(() =>
    publish([
      {
        ...privateState,
        privateResponses: {
          ...privateState.privateResponses!,
          canSeeAll: true,
        },
      },
    ])
  );
  expect(snapshot().recommendations).toEqual([recommendation]);
  expect(snapshot().votes).toEqual([]);
});

it("refreshes after a failed mutation so an explicit retry uses the latest version without auto-replaying", async () => {
  const doc = new Y.Doc();
  let lists = 0,
    answers = 0;
  const requestDecision = vi.fn(async (command) => {
    if (command.operation === "list") {
      lists++;
      return {
        ...authority,
        decisions: [
          {
            ...privateState,
            privateResponses: {
              ...privateState.privateResponses!,
              responseVersion: lists === 1 ? 3 : 4,
            },
          },
        ],
      };
    }
    answers++;
    if (answers === 1)
      throw new Error("Answer version changed or acknowledgement was lost.");
    return {
      ...authority,
      decisions: [
        {
          ...privateState,
          privateResponses: {
            ...privateState.privateResponses!,
            responseVersion: 5,
          },
        },
      ],
    };
  });
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
      }}
    >
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().canVote).toBe(true));
  await act(async () => fireEvent.click(screen.getByText("Answer")));
  expect(lists).toBe(2);
  expect(answers).toBe(1);
  expect(snapshot().error).toContain("version changed");
  await act(async () => fireEvent.click(screen.getByText("Answer")));
  expect(requestDecision).toHaveBeenLastCalledWith({
    operation: "answer",
    blockId: "dcn-private",
    answer: { type: "confirm", value: true },
    note: "my note",
    expectedVersion: 4,
  });
  expect(answers).toBe(2);
  expect(doc.getMap("decisions").size).toBe(0);
});

it("blocks repeat mutations during refresh and fails closed if refreshed authority is unavailable", async () => {
  const doc = new Y.Doc();
  let lists = 0,
    mutations = 0;
  let rejectRefresh!: (error: Error) => void;
  const requestDecision = vi.fn(async (command) => {
    if (command.operation === "list") {
      if (++lists === 1) return { ...authority, decisions: [privateState] };
      return new Promise<
        import("@nimbalyst/collab-protocol").DocumentDecisionResult
      >((_resolve, reject) => {
        rejectRefresh = reject;
      });
    }
    mutations++;
    throw new Error("Acknowledgement timed out");
  });
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
      }}
    >
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().canVote).toBe(true));
  await act(async () => fireEvent.click(screen.getByText("Answer")));
  expect(lists).toBe(2);
  expect(snapshot().pending).toBe(true);
  fireEvent.click(screen.getByText("Answer"));
  expect(mutations).toBe(1);
  await act(async () => rejectRefresh(new Error("Access unavailable")));
  expect(snapshot().pending).toBe(false);
  expect(snapshot().canVote).toBe(false);
  expect(snapshot().error).toContain("could not be refreshed");
  fireEvent.click(screen.getByText("Answer"));
  expect(mutations).toBe(1);
  expect(doc.getMap("decisions").size).toBe(0);
});

it("keeps open source ballots unknown without explicit supported authorization, including disconnect notifications", async () => {
  const doc = new Y.Doc();
  doc.getMap("decisions").set("dcn-private\x1falice", {
    answer: { type: "confirm", value: true },
    voterName: "RAW_SECRET",
    at: 1,
  });
  let publish!: Parameters<NonNullable<DecisionsConfig["onDecisionState"]>>[0];
  const config: DecisionsConfig = {
    getYDoc: () => doc,
    currentUser: { id: "bob", name: "Bob" },
    requestDecision: vi.fn().mockResolvedValue({ decisions: [] }),
    onDecisionState: (listener) => {
      publish = listener;
      return () => {};
    },
  };
  const view = render(
    <DecisionsProvider config={config}>
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  await act(async () => {});
  expect(snapshot().votes).toEqual([]);
  expect(snapshot().canVote).toBe(false);
  act(() => publish([], { loaded: true, privacyVersion: 1 }));
  expect(snapshot().votes).toHaveLength(1);
  act(() => publish([], { loaded: false }));
  expect(snapshot().votes).toEqual([]);
  expect(snapshot().canVote).toBe(false);
  view.rerender(
    <DecisionsProvider
      config={{ getYDoc: () => doc, currentUser: config.currentUser }}
    >
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  expect(snapshot().votes).toEqual([]);
  fireEvent.click(screen.getByText("Answer"));
  expect(doc.getMap("decisions").size).toBe(1);
});

it("does not reinstall a mutation result after subscription invalidation before its promise continuation", async () => {
  let publish!: NonNullable<DecisionsConfig["onDecisionState"]> extends (
    listener: infer L
  ) => unknown
    ? L
    : never;
  let resolveAnswer!: (
    result: import("@nimbalyst/collab-protocol").DocumentDecisionResult
  ) => void;
  const state = {
    ...privateState,
    privateResponses: {
      ...privateState.privateResponses!,
      canSeeAll: true,
      myVote: {
        voterId: "bob",
        answer: { type: "confirm" as const, value: true },
        at: 1,
      },
    },
  };
  const requestDecision = vi.fn(async (command) => {
    if (command.operation === "list")
      return { ...authority, decisions: [state] };
    return new Promise<
      import("@nimbalyst/collab-protocol").DocumentDecisionResult
    >((resolve) => {
      resolveAnswer = resolve;
    });
  });
  const doc = new Y.Doc();
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
        onDecisionState: (listener) => {
          publish = listener;
          return () => {};
        },
      }}
    >
      <Probe />
    </DecisionsProvider>
  );
  await waitFor(() => expect(snapshot().canVote).toBe(true));
  fireEvent.click(screen.getByText("Answer"));
  await act(async () => {
    publish([state], authority);
    resolveAnswer({ ...authority, decisions: [state] });
    publish([], { loaded: false });
  });
  expect(snapshot().mine).toBeUndefined();
  expect(snapshot().canVote).toBe(false);
  expect(snapshot().pending).toBe(false);
});

it("pins an edited-open private sibling from group metadata before its own Send registration", async () => {
  const doc = new Y.Doc();
  doc
    .getMap("decisions")
    .set("dcn-private\x1falice", {
      answer: { type: "confirm", value: true },
      voterName: "RAW_SECRET",
      at: 1,
    });
  const group = {
    ...privateState,
    blockId: "dcn-first",
    privateGroupBlockIds: ["dcn-first", "dcn-private"],
  };
  const requestDecision = vi
    .fn()
    .mockResolvedValue({ ...authority, decisions: [group] });
  let publish!: Parameters<NonNullable<DecisionsConfig["onDecisionState"]>>[0];
  render(
    <DecisionsProvider
      config={{
        getYDoc: () => doc,
        currentUser: { id: "bob", name: "Bob" },
        requestDecision,
        onDecisionState: (listener) => {
          publish = listener;
          return () => {};
        },
      }}
    >
      <Probe content={fence.replace("hiddenUntilAnswered", "open")} />
    </DecisionsProvider>
  );
  await act(async () => {});
  expect(snapshot().privateMode).toBe(true);
  expect(snapshot().canVote).toBe(false);
  expect(snapshot().canSeal).toBe(false);
  expect(snapshot().votes).toEqual([]);
  fireEvent.click(screen.getByText("Answer"));
  expect(requestDecision).toHaveBeenCalledTimes(1);
  expect(doc.getMap("decisions").size).toBe(1);
  act(() => publish([], { loaded: false }));
  expect(snapshot().privateMode).toBe(true);
  act(() => publish([group, privateState], authority));
  expect(snapshot().canVote).toBe(true);
  expect(snapshot().votes).toEqual([]);
});
