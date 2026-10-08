// @vitest-environment node

// NIM-834 follow-up: the SDK turn driver must never run a claude-code-cli
// session. That provider has no in-process driver - its sendMessage is the
// Phase 1 stub that throws - so a CLI session driven through ai:sendMessage
// stacks "not yet implemented (Phase 1)" errors in the transcript while the
// genuine CLI turn runs fine on its PTY.
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerFactory: {
    getProvider: vi.fn(),
    createProvider: vi.fn(),
  },
  stateManager: {
    startSession: vi.fn(),
    updateActivity: vi.fn(),
    endSession: vi.fn(),
    isSessionActive: vi.fn(() => false),
  },
}));

// MessageStreamingHandler pulls in most of the main process. Everything below
// exists only to let it import; nothing here is under test.
vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("@nimbalyst/runtime/ai/server", () => ({
  ProviderFactory: mocks.providerFactory,
  ModelRegistry: {
    getModelsForProvider: vi.fn(async () => []),
    getDefaultModel: vi.fn(),
  },
  OpenAICodexProvider: {
    normalizeModelSelection: vi.fn((model: string) => model),
  },
  isAgentProvider: vi.fn((provider: string) => provider === "opencode"),
  onAgentMessageBatch: vi.fn(() => vi.fn()),
  buildMetaAgentSystemPrompt: vi.fn(),
  buildDevAgentSystemPrompt: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/ai/server/SessionStateManager", () => ({
  getSessionStateManager: vi.fn(() => mocks.stateManager),
}));

vi.mock("@nimbalyst/runtime/ai/server/utils/errorDetection", () => ({
  isBedrockToolSearchError: vi.fn(() => false),
}));

vi.mock("@nimbalyst/runtime/ai/server/effortLevels", () => ({
  resolveEffortLevel: vi.fn(() => undefined),
  resolveThinkingMode: vi.fn(() => undefined),
}));

vi.mock("@nimbalyst/runtime/storage/repositories/AISessionsRepository", () => ({
  AISessionsRepository: { get: vi.fn() },
}));

vi.mock("@nimbalyst/runtime/ai/modelConstants", () => ({
  resolveClaudeCodeParentContextWindow: vi.fn(),
}));

vi.mock("@nimbalyst/runtime/types/MCPServerConfig", () => ({
  buildMcpSessionStatusSnapshot: vi.fn(() => ({})),
}));

vi.mock("../tools", () => ({
  toolRegistry: { getAll: vi.fn(() => []) },
}));

vi.mock("../providerResolution", () => ({
  resolveExtensionAgentRef: vi.fn(() => null),
  // A claude-code-cli or SDK session is neither the built-in gemini agent nor
  // an extension contribution, so the host does not supply its tool loop.
  usesHostSuppliedToolLoop: vi.fn(() => false),
}));

vi.mock("../../../extensions/AgentProviderRegistry", () => ({
  getAgentProviderRegistry: vi.fn(),
}));

vi.mock("../../SoundNotificationService", () => ({
  SoundNotificationService: {
    getInstance: vi.fn(() => ({ playCompletionSound: vi.fn() })),
  },
}));

vi.mock("../../NotificationService", () => ({
  notificationService: { showNotification: vi.fn() },
}));

vi.mock("../../../../shared/notificationTitle", () => ({
  composeNotificationTitle: vi.fn(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: {
    ai: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock("../../../window/WindowManager", () => ({
  windowStates: new Map(),
  findWindowByWorkspace: vi.fn(() => null),
}));

vi.mock("../../SessionFileTracker", () => ({
  sessionFileTracker: { trackUserMessage: vi.fn() },
}));

vi.mock("../../CodexEditWindowRegistry", () => ({
  codexEditWindowRegistry: { clearSession: vi.fn() },
  shouldOpenCodexEditWindow: vi.fn(() => false),
}));

vi.mock("../../ToolCallMatcher", () => ({
  toolCallMatcher: { matchSession: vi.fn() },
  unwrapShellCommand: vi.fn(),
}));

vi.mock("../../FeatureUsageService.ts", () => ({
  FeatureUsageService: {
    getInstance: vi.fn(() => ({ recordUsage: vi.fn() })),
  },
  FEATURES: {
    AI_PROMPT_SUBMITTED: "ai_prompt_submitted",
  },
}));

vi.mock("../../ToolUsageService", () => ({
  ToolUsageService: { getInstance: vi.fn() },
}));

vi.mock("../../../HistoryManager", () => ({
  historyManager: {},
}));

vi.mock("../../../file/WorkspaceEventBus", () => ({
  addGitignoreBypass: vi.fn(),
  // codexShellTrackingHost binds these at module load (GitStatusHandlers pulls it in).
  drainWorkspaceEvents: vi.fn(async () => {}),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  getSubscriberIds: vi.fn(() => []),
}));

vi.mock("../../SyncManager", () => ({
  getSyncProvider: vi.fn(() => null),
  isDesktopTrulyAway: vi.fn(() => false),
}));

vi.mock("../mobilePushRequest", () => ({
  requestMobilePush: vi.fn(),
}));

vi.mock("../pendingPromptPersistence", () => ({
  setSessionPendingPrompt: vi.fn(),
}));

vi.mock("../../AgentWorkflowService", () => ({
  getAgentWorkflowService: vi.fn(),
}));

vi.mock("../../../mcp/metaAgentServer", () => ({
  getMetaAgentOpenAITools: vi.fn(),
}));

vi.mock("../../../mcp/devAgentTools", () => ({
  getDevAgentOpenAITools: vi.fn(),
  resolveDevToolScope: vi.fn(),
}));

vi.mock("../../MetaAgentService", () => ({
  MetaAgentService: { getInstance: vi.fn() },
}));

vi.mock("../../../utils/store", () => ({
  getDefaultEffortLevel: vi.fn(() => undefined),
  getDefaultThinkingMode: vi.fn(() => undefined),
  getAppSetting: vi.fn(() => undefined),
  shouldShowCommunityPopup: vi.fn(() => false),
  markCommunityPopupShown: vi.fn(),
  wasCommunityPopupShownThisLaunch: vi.fn(() => false),
  incrementCompletedSessionsWithTools: vi.fn(),
}));

vi.mock("../childSessionTakeover", () => ({
  disableParentNotificationsAfterDirectTakeover: vi.fn(),
}));

vi.mock("../sessionSettlePolicy", () => ({
  shouldSettleUnterminatedTurn: vi.fn(() => false),
}));

vi.mock("../../tutorial/tutorialAnalytics", () => ({
  captureTutorialMilestone: vi.fn(),
}));

// The send handler claims an imported session before dispatch, and tracks a
// per-turn sibling inbox. Unmocked, both reach the database worker and
// analytics, which open a real settings store at import.
vi.mock("../../externalSessions/ExternalSessionService", () => ({
  claimExternalSessionForLocalExecution: vi.fn(),
}));
vi.mock("../sessionInboxService", () => ({
  sessionInbox: { begin: vi.fn(), current: vi.fn(), end: vi.fn(async () => undefined) },
}));
// Its static initializer is what opens that store, so every path to it counts.
vi.mock("../../analytics/AnalyticsService", () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

import { MessageStreamingHandler } from "../MessageStreamingHandler";

/** Records whether the SDK turn driver was entered at all. */
class RecordingProvider extends EventEmitter {
  sendMessageCalls = 0;

  constructor(private readonly chunks: Array<Record<string, unknown>> = []) {
    super();
  }

  async initialize() {}
  registerToolHandler() {}
  getCapabilities() {
    return { supportsFileTools: true };
  }
  async *sendMessage() {
    this.sendMessageCalls++;
    for (const chunk of this.chunks) yield chunk;
  }
}

function cliSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cli-session",
    provider: "claude-code-cli",
    model: "claude-opus-5",
    providerConfig: {},
    messages: [],
    workspacePath: "/workspace",
    ...overrides,
  };
}

function makeService(session: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    sessionManager: {
      loadSession: vi.fn(async () => session),
      addMessage: vi.fn(),
      updateSessionTitle: vi.fn(),
    },
    analytics: { sendEvent: vi.fn() },
    sendMessageHandler: null,
    processingQueuedPromptIds: new Set<string>(),
    matchDebounceTimers: new Map(),
    sessionsProcessingQueue: new Set(),
    documentContextService: {
      prepareContext: vi.fn(() => ({ documentContext: {}, userMessageAdditions: {} })),
    },
    hooklessWatcher: {
      ensureForSession: vi.fn(),
      stopForSession: vi.fn(),
      scheduleStop: vi.fn(),
    },
    getSettingsStore: vi.fn(),
    getApiKeyForProvider: vi.fn(() => undefined),
    buildClaudeCodeRuntimeConfig: vi.fn(),
    tryDispatchNextQueuedPrompt: vi.fn(async () => false),
    requestQueueDrive: vi.fn(),
    createToolHandler: vi.fn(() => vi.fn()),
    deliverPromptToClaudeCliSession: vi.fn(async () => {}),
    ...extra,
  };
}

const senderEvent = {
  sender: { id: 7, isDestroyed: vi.fn(() => false), send: vi.fn() },
} as never;

describe("MessageStreamingHandler claude-code-cli routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerFactory.getProvider.mockReturnValue(null);
  });

  it("hands the prompt to the CLI rails instead of the Phase 1 stub", async () => {
    const provider = new RecordingProvider();
    mocks.providerFactory.createProvider.mockReturnValue(provider);
    const session = cliSession();
    const service = makeService(session);

    const result = await new MessageStreamingHandler(service as never).handle(
      senderEvent,
      "Draft the reply",
      undefined,
      "cli-session",
      "/workspace",
    );

    expect(provider.sendMessageCalls).toBe(0);
    expect(service.deliverPromptToClaudeCliSession).toHaveBeenCalledWith({
      sessionId: "cli-session",
      workspacePath: "/workspace",
      prompt: "Draft the reply",
      queuedPromptId: undefined,
    });
    expect(result).toEqual({ content: "" });
  });

  it("hands a Kimi Code CLI prompt to the same terminal rails", async () => {
    const provider = new RecordingProvider();
    mocks.providerFactory.createProvider.mockReturnValue(provider);
    const session = cliSession({ id: "kimi-cli-session", provider: "kimi-code-cli", model: "kimi-code-cli:k3" });
    const service = makeService(session);

    await new MessageStreamingHandler(service as never).handle(
      senderEvent,
      "Rename the helper",
      undefined,
      "kimi-cli-session",
      "/workspace",
    );

    expect(provider.sendMessageCalls).toBe(0);
    expect(service.deliverPromptToClaudeCliSession).toHaveBeenCalledWith({
      sessionId: "kimi-cli-session",
      workspacePath: "/workspace",
      prompt: "Rename the helper",
      queuedPromptId: undefined,
    });
  });

  it("does not re-queue a prompt the queue already claimed", async () => {
    const provider = new RecordingProvider();
    mocks.providerFactory.createProvider.mockReturnValue(provider);
    const session = cliSession({ id: "cli-queued-session" });
    const service = makeService(session);

    await new MessageStreamingHandler(service as never).handle(
      senderEvent,
      "Queued work",
      { queuedPromptId: "queued-1" } as never,
      "cli-queued-session",
      "/workspace",
    );

    expect(provider.sendMessageCalls).toBe(0);
    expect(service.deliverPromptToClaudeCliSession).toHaveBeenCalledWith({
      sessionId: "cli-queued-session",
      workspacePath: "/workspace",
      prompt: "Queued work",
      queuedPromptId: "queued-1",
    });
    // The dedup mark must not outlive the call, or the next flush of that same
    // prompt id is silently skipped.
    expect(service.processingQueuedPromptIds.has("queued-1")).toBe(false);
  });

  it("still runs an SDK session through the provider", async () => {
    const provider = new RecordingProvider();
    mocks.providerFactory.createProvider.mockReturnValue(provider);
    const session = cliSession({
      id: "sdk-session",
      provider: "opencode",
      model: "opencode:anthropic/claude-sonnet-4",
    });
    const service = makeService(session);

    await new MessageStreamingHandler(service as never).handle(
      senderEvent,
      "Draft the reply",
      undefined,
      "sdk-session",
      "/workspace",
    );

    expect(service.deliverPromptToClaudeCliSession).not.toHaveBeenCalled();
    expect(provider.sendMessageCalls).toBe(1);
  });

  it("still sends when the file watcher refuses the workspace, as it does for a path near the drive root", async () => {
    const provider = new RecordingProvider();
    mocks.providerFactory.createProvider.mockReturnValue(provider);
    const session = cliSession({
      id: "shallow-session",
      provider: "opencode",
      model: "opencode:anthropic/claude-sonnet-4",
    });
    const service = makeService(session);
    service.hooklessWatcher.ensureForSession.mockRejectedValue(
      new Error('Workspace path "C:\\work" is too shallow (depth 2, minimum 3).'),
    );

    await new MessageStreamingHandler(service as never).handle(
      senderEvent,
      "Draft the reply",
      undefined,
      "shallow-session",
      "C:\\work",
    );

    // Live watching only feeds file attribution; losing it must not cost the turn.
    expect(provider.sendMessageCalls).toBe(1);
  });
});
