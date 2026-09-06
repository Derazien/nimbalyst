// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DocumentDecisionClient } from "../DocumentDecisionClient";

describe("DocumentDecisionClient", () => {
  it("requires server acknowledgement before delivery registration and correlates replies", async () => {
    const send = vi.fn();
    let ack!: (saved: boolean) => void;
    const client = new DocumentDecisionClient(
      send,
      () => true,
      () =>
        new Promise((resolve) => {
          ack = resolve;
        })
    );
    const request = client.request({
      operation: "send",
      blockId: "question",
      recipientIds: ["person"],
    });
    expect(send).not.toHaveBeenCalled();
    ack(true);
    await Promise.resolve();
    const message = send.mock.calls[0][0];
    client.receive({
      type: "docDecisionState",
      privacyVersion: 1,
      requestId: "unrelated",
      decisions: [],
    });
    client.receive({
      type: "docDecisionState",
      privacyVersion: 1,
      requestId: message.requestId,
      decisions: [],
    });
    await expect(request).resolves.toEqual({
      decisions: [],
      loaded: false,
      privacyVersion: 1,
    });
  });
  it("refuses unsaved sends and rejects pending work on socket teardown", async () => {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => false
    );
    await expect(
      client.request({ operation: "nudge", blockId: "question" })
    ).rejects.toThrow("not been saved");
    expect(send).not.toHaveBeenCalled();
    const listing = client.request({ operation: "list" });
    client.disconnect();
    await expect(listing).rejects.toThrow("disconnected");
  });
});

it("coalesces private-state invalidation without broadcasting answers and clears state on disconnect", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => true
    );
    client.invalidate();
    client.invalidate();
    client.invalidate();
    await vi.advanceTimersByTimeAsync(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].command).toEqual({ operation: "list" });
    client.receive({
      type: "docDecisionState",
      privacyVersion: 1,
      requestId: send.mock.calls[0][0].requestId,
      decisions: [{ blockId: "private" } as any],
    });
    expect(client.getState()).toHaveLength(1);
    client.disconnect();
    expect(client.getState()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("reports a pending answer through flush and server acknowledgement so closing the view can warn", async () => {
  const send = vi.fn();
  let flush!: (value: boolean) => void;
  const client = new DocumentDecisionClient(
    send,
    () => true,
    () =>
      new Promise((resolve) => {
        flush = resolve;
      })
  );
  const answer = client.request({
    operation: "answer",
    blockId: "private",
    answer: { type: "confirm", value: true },
    expectedVersion: 0,
  });
  expect(client.hasPendingMutations()).toBe(true);
  flush(true);
  await Promise.resolve();
  expect(client.hasPendingMutations()).toBe(true);
  client.receive({
    type: "docDecisionState",
    privacyVersion: 1,
    requestId: send.mock.calls[0][0].requestId,
    decisions: [],
  });
  await answer;
  expect(client.hasPendingMutations()).toBe(false);
});

it("coalesces concurrent lists and rejects unsolicited, out-of-order, duplicate, or late projections", async () => {
  const send = vi.fn();
  const client = new DocumentDecisionClient(
    send,
    () => true,
    async () => true
  );
  const reply = (requestId: string, blockId: string) =>
    client.receive({
      type: "docDecisionState",
      requestId,
      decisions: [{ blockId } as any],
      ...{ privacyVersion: 1 as const },
    });
  reply("unrelated", "leaked");
  expect(client.getState()).toEqual([]);
  const older = client.request({ operation: "list" });
  const newer = client.request({ operation: "list" });
  expect(send).toHaveBeenCalledTimes(1);
  reply(send.mock.calls[0][0].requestId, "current");
  await Promise.all([older, newer]);
  reply(send.mock.calls[0][0].requestId, "stale");
  expect(client.getState()[0].blockId).toBe("current");
  const earlierWrite = client.request({
    operation: "nudge",
    blockId: "private",
  });
  const laterWrite = client.request({ operation: "nudge", blockId: "private" });
  await Promise.resolve();
  reply(send.mock.calls[2][0].requestId, "newest");
  await laterWrite;
  reply(send.mock.calls[1][0].requestId, "obsolete");
  await expect(earlierWrite).resolves.toMatchObject({ loaded: false });
  expect(client.getState()[0].blockId).toBe("newest");
  client.disconnect();
  reply(send.mock.calls[0][0].requestId, "late");
  expect(client.getState()).toEqual([]);
});

it("clears authority synchronously on invalidation and repeats a list invalidated in flight", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => true
    );
    const listener = vi.fn();
    client.subscribe(listener);
    const reply = (index: number) =>
      client.receive({
        type: "docDecisionState",
        requestId: send.mock.calls[index][0].requestId,
        decisions: [{ blockId: "private" } as any],
        ...{ privacyVersion: 1 as const },
      });
    const initial = client.request({ operation: "list" });
    reply(0);
    await initial;
    client.invalidate();
    expect(client.getState()).toEqual([]);
    expect(listener.mock.lastCall?.[1]).toMatchObject({ loaded: false });
    await vi.advanceTimersByTimeAsync(10);
    client.invalidate();
    reply(1);
    expect(client.getState()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(3);
    reply(2);
    expect(client.getState()).toHaveLength(1);
    expect(listener.mock.lastCall?.[1]).toMatchObject({
      loaded: true,
      privacyVersion: 1,
    });
    client.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

it("treats old-server replies as unknown and clears cached answers on an authorized error", async () => {
  const send = vi.fn();
  const client = new DocumentDecisionClient(
    send,
    () => true,
    async () => true
  );
  const old = client.request({ operation: "list" });
  client.receive({
    type: "docDecisionState",
    requestId: send.mock.calls[0][0].requestId,
    decisions: [{ blockId: "unsafe" } as any],
  });
  expect(await old).toMatchObject({ decisions: [], loaded: false });
  const current = client.request({ operation: "list" });
  client.receive({
    type: "docDecisionState",
    requestId: send.mock.calls[1][0].requestId,
    decisions: [{ blockId: "private" } as any],
    ...{ privacyVersion: 1 as const },
  });
  await current;
  const failed = client.request({ operation: "list" });
  client.receive({
    type: "docDecisionState",
    requestId: send.mock.calls[2][0].requestId,
    decisions: [],
    error: "Access denied",
  });
  await expect(failed).rejects.toThrow("Access denied");
  expect(client.getState()).toEqual([]);
});

it("clears on timeout, ignores late replies, and never sends a mutation across disconnect during flush", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    let finishFlush!: (saved: boolean) => void;
    const client = new DocumentDecisionClient(
      send,
      () => true,
      () =>
        new Promise((resolve) => {
          finishFlush = resolve;
        })
    );
    const initial = client.request({ operation: "list" });
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[0][0].requestId,
      decisions: [{ blockId: "private" } as any],
      privacyVersion: 1,
    });
    await initial;
    const timed = client.request({ operation: "list" });
    const timedResult = expect(timed).rejects.toThrow("could not be confirmed");
    await vi.advanceTimersByTimeAsync(15000);
    await timedResult;
    expect(client.getState()).toEqual([]);
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[1][0].requestId,
      decisions: [{ blockId: "late" } as any],
      privacyVersion: 1,
    });
    expect(client.getState()).toEqual([]);
    const write = client.request({
      operation: "retract",
      blockId: "private",
      expectedVersion: 1,
    });
    expect(client.hasPendingMutations()).toBe(true);
    client.disconnect();
    finishFlush(true);
    await expect(write).rejects.toThrow("disconnected");
    expect(send).toHaveBeenCalledTimes(2);
    expect(client.hasPendingMutations()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("clears authority when the pre-mutation flush rejects", async () => {
  const send = vi.fn();
  const client = new DocumentDecisionClient(
    send,
    () => true,
    async () => {
      throw new Error("Save failed");
    }
  );
  const initial = client.request({ operation: "list" });
  client.receive({
    type: "docDecisionState",
    requestId: send.mock.calls[0][0].requestId,
    decisions: [{ blockId: "private" } as any],
    privacyVersion: 1,
  });
  await initial;
  await expect(
    client.request({
      operation: "retract",
      blockId: "private",
      expectedVersion: 1,
    })
  ).rejects.toThrow("Save failed");
  expect(client.getState()).toEqual([]);
  expect(client.hasPendingMutations()).toBe(false);
});

it("settles an answer during durable and reconciled invalidations without replay or a stranded refresh", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => true
    );
    const answer = client.request({
      operation: "answer",
      blockId: "private",
      answer: { type: "confirm", value: true },
      expectedVersion: 0,
    });
    await Promise.resolve();
    client.invalidate();
    client.invalidate();
    expect(client.hasPendingMutations()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(2);
    client.invalidate();
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[0][0].requestId,
      privacyVersion: 1,
      decisions: [],
    });
    await expect(answer).resolves.toMatchObject({ loaded: false });
    expect(client.hasPendingMutations()).toBe(false);
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[1][0].requestId,
      privacyVersion: 1,
      decisions: [],
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(3);
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[2][0].requestId,
      privacyVersion: 1,
      decisions: [{ blockId: "private" } as any],
    });
    expect(client.getState()).toHaveLength(1);
    expect(
      send.mock.calls.filter(
        ([message]) => message.command.operation === "answer"
      )
    ).toHaveLength(1);
    client.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

it("retries a caller's invalidated list and returns only a fresh authorized projection without manual retry", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => true
    );
    const outcome = client.request({ operation: "list" }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    client.invalidate();
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[0][0].requestId,
      privacyVersion: 1,
      decisions: [{ blockId: "STALE" } as any],
    });
    expect(client.getState()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(2);
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[1][0].requestId,
      privacyVersion: 1,
      decisions: [{ blockId: "fresh" } as any],
    });
    expect(await outcome).toEqual({
      value: {
        decisions: [{ blockId: "fresh" }],
        loaded: true,
        privacyVersion: 1,
      },
    });
    client.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

it("bounds stale-read retries and stops on disconnect during the retry pause", async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn();
    const client = new DocumentDecisionClient(
      send,
      () => true,
      async () => true
    );
    const result = client
      .request({ operation: "list" })
      .catch((error) => error);
    for (let index = 0; index < 4; index++) {
      client.invalidate();
      client.receive({
        type: "docDecisionState",
        requestId: send.mock.calls[index][0].requestId,
        privacyVersion: 1,
        decisions: [],
      });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(await result).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(4);
    expect(client.getState()).toEqual([]);
    const disconnected = client
      .request({ operation: "list" })
      .catch((error) => error);
    client.invalidate();
    client.receive({
      type: "docDecisionState",
      requestId: send.mock.calls[4][0].requestId,
      privacyVersion: 1,
      decisions: [],
    });
    await Promise.resolve();
    client.disconnect();
    expect((await disconnected).message).toContain("disconnected");
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["server", "timeout", "unsupported"])(
  "never retries %s list failures or unknown capability",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const client = new DocumentDecisionClient(
        send,
        () => true,
        async () => true
      );
      const result = client
        .request({ operation: "list" })
        .catch((error) => error);
      client.invalidate();
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(15000);
      else
        client.receive({
          type: "docDecisionState",
          requestId: send.mock.calls[0][0].requestId,
          decisions: [],
          ...(failure === "server"
            ? { error: "Feedback status changed while loading. Refresh again." }
            : {}),
        });
      const outcome = await result;
      if (failure === "unsupported")
        expect(outcome).toMatchObject({ loaded: false, decisions: [] });
      else expect(outcome).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledTimes(1);
      expect(client.getState()).toEqual([]);
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  }
);
