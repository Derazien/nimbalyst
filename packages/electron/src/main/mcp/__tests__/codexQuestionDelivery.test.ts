// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  rows: [] as any[],
  create: vi.fn(async (row: any) => {
    mocks.rows.push(row);
    return row;
  }),
  get: vi.fn(async () => ({
    id: "session",
    provider: "openai-codex",
    workspacePath: "/workspace",
  })),
  queue: new Map<string, any>(),
  drive: vi.fn(async (): Promise<any> => ({ kind: "dispatched" })),
  queueCreate: vi.fn(async (row: any) => {
    const value = { ...row, status: "pending" };
    mocks.queue.set(row.id, value);
    return value;
  }),
  active: false,
  updateActivity: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  ipcMain: new EventEmitter(),
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn),
}));
vi.mock(
  "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository",
  () => ({
    AgentMessagesRepository: {
      create: mocks.create,
      listTail: async () => mocks.rows,
      list: async () => mocks.rows,
    },
  })
);
vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: mocks.get },
}));
vi.mock("@nimbalyst/runtime/ai/server", () => ({
  ProviderFactory: { getProvider: () => undefined },
  isAskUserQuestionProvider: () => false,
}));
vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: () => ({
    isSessionActive: () => mocks.active,
    updateActivity: mocks.updateActivity,
  }),
}));
vi.mock("../../services/ai/pendingPromptPersistence", () => ({
  setSessionPendingPrompt: async () => {},
}));
vi.mock("../../services/SyncManager", () => ({
  getSyncProvider: () => undefined,
}));
vi.mock("../../tray/TrayManager", () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved() {} }) },
}));
vi.mock("../../services/NotificationService", () => ({
  notificationService: {},
}));
vi.mock("../../services/ClaudeSettingsManager", () => ({
  ClaudeSettingsManager: {},
}));
vi.mock("../../services/PermissionService", () => ({
  getPermissionService: vi.fn(),
}));
vi.mock("../../services/SessionCommitService", () => ({
  SessionCommitService: {},
}));
vi.mock("../../services/RepositoryManager", () => ({
  getQueuedPromptsStore: () => ({
    get: async (id: string) => mocks.queue.get(id),
    create: mocks.queueCreate,
  }),
}));
vi.mock("../../window/WindowManager", () => ({}));
vi.mock("../mcpWorkspaceResolver", () => ({
  findWindowIdForWorkspacePath: vi.fn(),
}));

import { codexQuestionTurns } from "../../services/ai/codexQuestionTurns";
import { deliverCodexQuestionAnswer } from "../../services/ai/codexQuestionDelivery";
import { ipcMain } from "electron";
import { handleAskUserQuestion } from "../tools/askUserQuestionHandler";
import { registerSessionPromptResponseHandler } from "../../ipc/sessionPromptResponseHandler";
import { registerInteractivePromptHandlers } from "../../services/ai/ipc/registerInteractivePromptHandlers";

const question = {
  header: "Next",
  question: "Proceed?",
  options: [{ label: "Design", description: "Write the plan" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.length = 0;
  mocks.queue.clear();
  mocks.handlers.clear();
  mocks.active = false;
  mocks.drive.mockResolvedValue({ kind: "dispatched" });
});
afterEach(() => {
  ipcMain.removeAllListeners();
});

function setup() {
  registerInteractivePromptHandlers({
    driveQueuedPrompts: mocks.drive,
    publishQueueStateToSync: async () => {},
  } as any);
  const turn = codexQuestionTurns.begin("session");
  codexQuestionTurns.observe(turn, {
    id: "exec-question",
    name: "mcp__nimbalyst__AskUserQuestion",
    arguments: { questions: [question] },
  });
  return turn;
}
async function openQuestion() {
  const pending = handleAskUserQuestion(
    { questions: [question] },
    "session",
    {}
  );
  await vi.waitFor(() =>
    expect(
      [...codexQuestionTurns.current("session")!.questions].some(
        (q) => q.waiter
      )
    ).toBe(true)
  );
  return { pending };
}
const submit = () =>
  mocks.handlers.get("claude-code:answer-question")!(
    {},
    {
      sessionId: "session",
      questionId: `nimtc|exec-question|${
        codexQuestionTurns.current("session")!.startedAt
      }|1`,
      answers: { "Proceed?": "Design" },
    }
  );
afterEach(async () => {
  await codexQuestionTurns.end(codexQuestionTurns.current("session"));
});

describe("Codex first answer delivery", () => {
  it("recovers the first answer after the turn ended without an MCP abort", async () => {
    const turn = setup();
    const { pending } = await openQuestion();
    await codexQuestionTurns.end(turn);
    await pending;
    await submit();
    expect(mocks.drive).toHaveBeenCalledTimes(1);
    expect([...mocks.queue.values()][0].prompt).toContain("Proceed?: Design");
    expect(mocks.updateActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" })
    );
    expect(ipcMain.listenerCount("ask-user-question:session")).toBe(0);
  });

  it("returns a live answer to the real MCP call and does not resume a completed tool", async () => {
    const turn = setup();
    const { pending } = await openQuestion();
    expect(await submit()).toMatchObject({ delivery: "live" });
    expect(JSON.parse((await pending).content[0].text).answers).toEqual({
      "Proceed?": "Design",
    });
    await codexQuestionTurns.observe(turn, {
      id: "exec-question",
      name: "mcp__nimbalyst__AskUserQuestion",
      result: { answers: { "Proceed?": "Design" } },
    });
    await codexQuestionTurns.end(turn);
    expect(mocks.drive).not.toHaveBeenCalled();
  });

  it("recovers once when the turn ends after accepting an answer but before tool completion", async () => {
    const turn = setup();
    const { pending } = await openQuestion();
    await Promise.all([submit(), submit()]);
    await pending;
    await codexQuestionTurns.end(turn);
    expect(mocks.queue.size).toBe(1);
    await submit();
    expect(mocks.queue.size).toBe(1);
  });

  it("leaves a failed answer write retryable and does not wake the waiter", async () => {
    setup();
    const { pending } = await openQuestion();
    mocks.create.mockRejectedValueOnce(new Error("write failed"));
    await expect(submit()).rejects.toThrow("write failed");
    expect(
      [...codexQuestionTurns.current("session")!.questions].some(
        (q) => q.waiter
      )
    ).toBe(true);
    expect(await submit()).toMatchObject({ delivery: "live" });
    await pending;
  });

  it("shares desktop and mobile claims without duplicate continuations", async () => {
    const turn = setup();
    const { pending } = await openQuestion();
    await codexQuestionTurns.end(turn);
    await pending;
    await Promise.all([
      submit(),
      deliverCodexQuestionAnswer("session", "exec-question", {
        answers: { "Proceed?": "Design" },
        respondedBy: "mobile",
      }),
    ]);
    expect(mocks.queue.size).toBe(1);
    expect(mocks.drive).toHaveBeenCalled();
  });

  it("rejects a late waiter registration without restoring an ended turn to waiting", async () => {
    const turn = setup();
    let release: ((value: any) => void) | undefined;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = handleAskUserQuestion(
      { questions: [question] },
      "session",
      {}
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await codexQuestionTurns.end(turn);
    release!({ provider: "openai-codex" });
    expect((await pending).isError).toBe(true);
    expect(mocks.updateActivity).not.toHaveBeenCalled();
  });

  it("keeps an old answer and late old-turn cleanup away from a newer question with the same raw ID", async () => {
    const first = setup();
    const oldId = `nimtc|exec-question|${first.startedAt}|1`;
    const old = await openQuestion();
    await codexQuestionTurns.end(first);
    await old.pending;
    const second = setup();
    const next = await openQuestion();
    await codexQuestionTurns.end(first);
    registerSessionPromptResponseHandler();
    const send = vi.fn();
    await mocks.handlers.get("messages:respond-to-prompt")!(
      { sender: { send } },
      {
        sessionId: "session",
        promptId: oldId,
        promptType: "ask_user_question_request",
        response: { answers: { "Proceed?": "Old answer" } },
        respondedBy: "mobile",
      }
    );
    expect(send).not.toHaveBeenCalled();
    expect([...second.questions].some((q) => q.waiter)).toBe(true);
    await submit();
    expect(JSON.parse((await next.pending).content[0].text).answers).toEqual({
      "Proceed?": "Design",
    });
  });

  it("deduplicates persisted completed answers after the original turn is replaced", async () => {
    const first = setup();
    const id = `nimtc|exec-question|${first.startedAt}|1`;
    const { pending } = await openQuestion();
    await submit();
    await pending;
    await codexQuestionTurns.observe(first, {
      id: "exec-question",
      name: "mcp__nimbalyst__AskUserQuestion",
      result: {},
    });
    await codexQuestionTurns.end(first);
    setup();
    expect(
      await deliverCodexQuestionAnswer("session", id, {
        answers: { "Proceed?": "Design" },
        respondedBy: "desktop",
      })
    ).toMatchObject({ delivery: "already-answered" });
    expect(mocks.queue.size).toBe(0);
  });

  it("reuses the queue receipt when terminal-result persistence fails", async () => {
    const turn = setup();
    await codexQuestionTurns.end(turn);
    mocks.create
      .mockImplementationOnce(async (row) => {
        mocks.rows.push(row);
        return row;
      })
      .mockRejectedValueOnce(new Error("terminal write failed"));
    await expect(submit()).rejects.toThrow("terminal write failed");
    expect(mocks.queue.size).toBe(1);
    await submit();
    expect(mocks.queue.size).toBe(1);
    expect(mocks.queueCreate).toHaveBeenCalledTimes(1);
  });

  it("surfaces drive failure while preserving a retryable receipt and respects deferred FIFO delivery", async () => {
    const turn = setup();
    await codexQuestionTurns.end(turn);
    mocks.drive.mockResolvedValueOnce({
      kind: "failed",
      reason: "workspace unavailable",
    });
    await expect(submit()).rejects.toThrow("saved in the queue");
    mocks.drive.mockResolvedValueOnce({
      kind: "deferred",
      reason: "session-busy",
    });
    expect(await submit()).toMatchObject({ delivery: "queued" });
    expect(mocks.queueCreate).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failed continuation or resume a cancelled question", async () => {
    const turn = setup();
    const id = `nimtc|exec-question|${turn.startedAt}|1`;
    const { pending } = await openQuestion();
    await deliverCodexQuestionAnswer("session", id, {
      answers: {},
      cancelled: true,
      respondedBy: "mobile",
    });
    await pending;
    await codexQuestionTurns.end(turn);
    expect(mocks.queue.size).toBe(0);
    const second = setup();
    await codexQuestionTurns.end(second);
    await submit();
    const receipt = [...mocks.queue.values()][0];
    receipt.status = "failed";
    receipt.errorMessage = "provider failed";
    await expect(submit()).rejects.toThrow("Retry the failed queued prompt");
    expect(mocks.queueCreate).toHaveBeenCalledTimes(1);
  });

  it("uses the same recovery path for the durable prompt-response IPC", async () => {
    const turn = setup();
    await codexQuestionTurns.end(turn);
    registerSessionPromptResponseHandler();
    const send = vi.fn();
    const result = await mocks.handlers.get("messages:respond-to-prompt")!(
      { sender: { send } },
      {
        sessionId: "session",
        promptId: `nimtc|exec-question|${turn.startedAt}|1`,
        promptType: "ask_user_question_request",
        response: { answers: { "Proceed?": "Design" } },
        respondedBy: "mobile",
      }
    );
    expect(result).toMatchObject({ success: true, delivery: "queued" });
    expect(mocks.queue.size).toBe(1);
    expect(send).toHaveBeenCalledWith(
      "ai:askUserQuestionAnswered",
      expect.objectContaining({ sessionId: "session" })
    );
  });

  it("serializes a retry with turn-end recovery while its queue write is still in flight", async () => {
    const turn = setup();
    const { pending } = await openQuestion();
    await submit();
    await pending;
    let release: (() => void) | undefined;
    mocks.queueCreate.mockImplementationOnce(async (row) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = { ...row, status: "pending" };
      mocks.queue.set(row.id, value);
      return value;
    });
    const retirement = codexQuestionTurns.end(turn);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const retry = submit();
    release!();
    await Promise.all([retirement, retry]);
    expect(mocks.queueCreate).toHaveBeenCalledTimes(1);
  });

  it("correlates a waiter registered before its tool-start observation and supports desktop cancellation", async () => {
    registerInteractivePromptHandlers({
      driveQueuedPrompts: mocks.drive,
      publishQueueStateToSync: async () => {},
    } as any);
    const turn = codexQuestionTurns.begin("session");
    const { pending } = await openQuestion();
    await codexQuestionTurns.observe(turn, {
      id: "exec-question",
      name: "mcp__nimbalyst__AskUserQuestion",
      arguments: { questions: [question] },
    });
    await mocks.handlers.get("claude-code:cancel-question")!(
      {},
      {
        sessionId: "session",
        questionId: `nimtc|exec-question|${turn.startedAt}|1`,
      }
    );
    expect(JSON.parse((await pending).content[0].text).cancelled).toBe(true);
    await codexQuestionTurns.end(turn);
    expect(mocks.queueCreate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "recovers a first answer after transport failure (orphaned=%s)",
    async (orphaned) => {
      const turn = setup();
      const { pending } = await openQuestion();
      await codexQuestionTurns.observe(turn, {
        id: "exec-question",
        name: "mcp__nimbalyst__AskUserQuestion",
        result: { success: false, error: "Tool call ended without a result" },
        orphaned,
      });
      expect((await pending).isError).toBe(true);
      await codexQuestionTurns.end(turn);
      expect(await submit()).toMatchObject({ delivery: "queued" });
      expect(mocks.queueCreate).toHaveBeenCalledTimes(1);
    }
  );
});
