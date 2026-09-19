/**
 * KimiACPProtocol -- AgentProtocol adapter for Kimi Code CLI's ACP mode.
 *
 * Spawns `kimi acp` and speaks the Agent Client Protocol over stdio via the
 * official @agentclientprotocol/sdk ClientSideConnection, the same transport
 * CodexACPProtocol uses. Kimi authenticates with its own CLI login
 * (`kimi login`, device-code flow); there is no API-key path, so the child
 * environment is only scrubbed, never augmented.
 *
 * Kimi-specific behavior captured here (verified against kimi CLI 0.43.1):
 *   - `session/new` returns a model picker in `configOptions` (id: "model")
 *     whose values are full alias strings like `kimi-code/k3`.
 *   - Model switching goes through `session/set_model`, falling back to
 *     `session/set_config_option` {configId: "model"}.
 *   - `session/load` replays history as session/update notifications before
 *     its response settles; replayed updates are dropped because no turn is
 *     active for the session yet (same gate CodexACPProtocol relies on).
 *   - `session/fork` branches a session (cwd/mcpServers are ignored by kimi).
 *   - Gated calls fail with JSON-RPC error -32000 when the user is logged
 *     out; surfaced as an error that names `kimi login`.
 *   - Permission options use the ids approve_once / approve_always / reject.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Readable, Writable } from 'stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  CancelNotification,
  McpServer,
  PermissionOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  Usage,
  UsageUpdate,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import {
  AgentProtocol,
  MCPServerConfig,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
  ToolResult,
} from './ProtocolInterface';
import { appendBoundedTail } from './CodexACPProtocol';
import { scrubProviderApiKeys } from '../providerApiKeyScrub';
import { buildDocumentAttachmentPromptText } from '../providers/codex/documentAttachmentPrompt';
import type { ToolPermissionScope } from '../providers/ProviderPermissionMixin';

interface KimiACPToolPermissionRequest {
  requestId: string;
  /** Provider-side ACP session id. */
  sessionId: string;
  /** Host session id used by Nimbalyst's permission persistence/UI. */
  nimbalystSessionId?: string;
  toolName: string;
  toolTitle: string;
  toolKind?: string | null;
  toolInput?: unknown;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/**
 * Callback invoked before the ACP agent writes a file.
 * Used to capture pre-edit baselines for diff rendering.
 */
export type OnBeforeKimiFileWrite = (filePath: string, sessionId: string | undefined) => Promise<void>;

/**
 * Callback invoked after a turn completes with the set of files edited during the turn.
 * Used to create turn-end snapshots for local history.
 */
export type OnKimiTurnFilesEdited = (filePaths: Set<string>, sessionId: string | undefined) => Promise<void>;

interface KimiACPProtocolDeps {
  spawnProcess?: typeof spawn;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  onPermissionRequest?: (
    request: KimiACPToolPermissionRequest
  ) => Promise<{ decision: 'allow' | 'deny'; scope: ToolPermissionScope }>;
  onBeforeFileWrite?: OnBeforeKimiFileWrite;
  onTurnFilesEdited?: OnKimiTurnFilesEdited;
}

interface ActiveTurnState {
  /** ACP session id (used for activeTurns keying and ACP-side correlation). */
  sessionId: string;
  /**
   * Nimbalyst session id (passed via ProtocolMessage.sessionId). Hooks like
   * onBeforeFileWrite/onTurnFilesEdited operate on Nimbalyst sessions
   * (session_files, document_history), so this is what they get.
   */
  nimbalystSessionId?: string;
  queue: AsyncEventQueue<ProtocolEvent>;
  latestContext?: UsageUpdate;
  /** Assistant text accumulated this turn, reported on the complete event. */
  fullText: string;
  filesEditedThisTurn: Set<string>;
}

interface SessionToolState {
  name: string;
  title: string;
  kind?: string | null;
  rawInput?: unknown;
  locations?: ToolCallLocation[] | null;
  /**
   * Whether a tool_call event has been emitted for this call. Real kimi
   * announces a call with a bare title and sends the arguments in a later
   * in_progress update, so the event waits for that update (or the terminal
   * one) rather than showing an empty card.
   */
  announced: boolean;
}

interface KimiSessionState {
  /** Model alias kimi is currently running, when observed. */
  currentModel?: string;
  /** Aliases offered by the session/new configOptions model picker. */
  availableModels: string[];
  /** Session mode kimi is currently in, when observed (default / plan / auto / yolo). */
  currentMode?: string;
  /** Mode ids kimi offered on session/new, load or fork. Empty means unknown. */
  availableModes: string[];
}

/**
 * kimi session mode for a Nimbalyst turn mode. Nimbalyst's planning mode maps
 * onto kimi's read-only `plan` mode, so a planning turn cannot write files
 * even though permission requests are answered automatically.
 */
function kimiModeForTurn(mode: ProtocolMessage['mode']): string {
  return mode === 'planning' ? 'plan' : 'default';
}

type ACPClientConnection = InstanceType<typeof ClientSideConnection>;

/** Cap on retained stderr bytes; kimi streams logs to stderr. */
const STDERR_TAIL_LIMIT_BYTES = 64 * 1024;

/**
 * JSON-RPC error code kimi returns on gated calls when the user is not
 * logged in (authRequired). Surfaced with a `kimi login` instruction so the
 * provider layer's auth-error mapping can pick it up.
 */
const KIMI_AUTH_REQUIRED_CODE = -32000;

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }
    if (this.done) {
      return { value: undefined as T, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class KimiACPProtocol implements AgentProtocol {
  readonly platform = 'kimi-acp';

  private command: string;
  private args: string[];
  /** An injected command (tests, embedding hosts) is never replaced by path discovery. */
  private readonly commandPinned: boolean;
  private processEnv: Record<string, string> | undefined;
  private readonly spawnProcess;
  private readonly extraEnv: Record<string, string>;
  private readonly onPermissionRequest?: KimiACPProtocolDeps['onPermissionRequest'];
  private readonly onBeforeFileWrite?: OnBeforeKimiFileWrite;
  private readonly onTurnFilesEdited?: OnKimiTurnFilesEdited;

  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ACPClientConnection | null = null;
  private initializationPromise: Promise<void> | null = null;
  private onProcessExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly sessionTools = new Map<string, Map<string, SessionToolState>>();
  private readonly sessionStates = new Map<string, KimiSessionState>();
  private readonly knownSessionIds = new Set<string>();
  private processExitError: Error | null = null;

  constructor(kimiPath?: string, deps?: KimiACPProtocolDeps) {
    this.command = deps?.command || kimiPath || 'kimi';
    this.args = deps?.args ?? ['acp'];
    this.commandPinned = !!deps?.command;
    this.spawnProcess = deps?.spawnProcess ?? spawn;
    this.extraEnv = deps?.env ?? {};
    this.onPermissionRequest = deps?.onPermissionRequest;
    this.onBeforeFileWrite = deps?.onBeforeFileWrite;
    this.onTurnFilesEdited = deps?.onTurnFilesEdited;
  }

  setKimiPath(path: string): void {
    if (this.commandPinned) {
      return;
    }
    this.command = path;
    this.args = ['acp'];
  }

  setProcessEnv(env: Record<string, string> | undefined): void {
    this.processEnv = env;
  }

  /** Useful for diagnostics: returns the binary path the protocol will spawn. */
  getResolvedCommand(): string {
    return this.command;
  }

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    const connection = await this.getConnection();
    let result;
    try {
      const convertedMcpServers = this.convertMcpServers(options.mcpServers);
      result = await connection.newSession({
        cwd: options.workspacePath,
        mcpServers: convertedMcpServers,
      });

      this.registerSession(result.sessionId);
      this.captureConfigOptions(result.sessionId, result.configOptions);
      this.captureModes(result.sessionId, result.modes);
      const appliedModel = await this.applySessionModel(connection, result.sessionId, options.model);

      return this.buildProtocolSession(result.sessionId, options, appliedModel, convertedMcpServers.length);
    } catch (error) {
      console.error('[KimiACPProtocol] newSession failed:', this.formatError(error));
      throw this.toSessionError(error, 'Failed to create Kimi ACP session');
    }
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const connection = await this.getConnection();

    if (!this.knownSessionIds.has(sessionId)) {
      let resumed = false;
      try {
        // kimi replays the conversation history as session/update notifications
        // before this call settles. They are dropped in handleSessionUpdate
        // because no turn is active for the session yet -- the same replay
        // gate CodexACPProtocol relies on.
        const loaded = await connection.loadSession({
          sessionId,
          cwd: options.workspacePath,
          mcpServers: this.convertMcpServers(options.mcpServers),
        });
        this.registerSession(sessionId);
        this.captureModes(sessionId, loaded.modes);
        resumed = true;
      } catch (error) {
        if (this.isAuthError(error)) {
          throw this.toSessionError(error, 'Failed to resume Kimi ACP session');
        }
        resumed = false;
      }

      if (!resumed) {
        return this.createSession(options);
      }
    }

    this.registerSession(sessionId);
    const appliedModel = await this.applySessionModel(connection, sessionId, options.model);

    return this.buildProtocolSession(sessionId, options, appliedModel);
  }

  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    const connection = await this.getConnection();

    try {
      // kimi supports session/fork natively; it ignores cwd/mcpServers on the
      // fork, but the schema requires cwd, so pass the requested values.
      const result = await connection.unstable_forkSession({
        sessionId,
        cwd: options.workspacePath,
        mcpServers: this.convertMcpServers(options.mcpServers),
      });

      this.registerSession(result.sessionId);
      const sourceState = this.sessionStates.get(sessionId);
      if (sourceState) {
        this.sessionStates.set(result.sessionId, {
          ...sourceState,
          availableModels: [...sourceState.availableModels],
          availableModes: [...sourceState.availableModes],
        });
      }
      this.captureConfigOptions(result.sessionId, result.configOptions);
      this.captureModes(result.sessionId, result.modes);
      const appliedModel = await this.applySessionModel(connection, result.sessionId, options.model);

      return this.buildProtocolSession(result.sessionId, options, appliedModel);
    } catch (error) {
      if (this.isAuthError(error)) {
        throw this.toSessionError(error, 'Failed to fork Kimi ACP session');
      }
      console.warn('[KimiACPProtocol] session/fork failed, creating a fresh session:', this.formatError(error));
      return this.createSession(options);
    }
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage
  ): AsyncIterable<ProtocolEvent> {
    const connection = await this.getConnection();
    const queue = new AsyncEventQueue<ProtocolEvent>();
    const turnState: ActiveTurnState = {
      sessionId: session.id,
      nimbalystSessionId: message.sessionId,
      queue,
      fullText: '',
      filesEditedThisTurn: new Set(),
    };

    this.activeTurns.set(session.id, turnState);
    if (!this.sessionTools.has(session.id)) {
      this.sessionTools.set(session.id, new Map());
    }

    // Per-message signal only: sessions are cached across turns, so a signal
    // captured at session creation would be stale by the second turn.
    const abortSignal = message.abortSignal;
    const abortHandler = () => {
      void this.cancelPrompt(session.id);
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    const promptTask = (async () => {
      try {
        // Before every turn, so a resumed session and a mode switch between
        // turns both land on the right kimi mode.
        await this.applySessionMode(connection, session.id, kimiModeForTurn(message.mode));
        const promptBlocks = await this.buildPromptBlocks(message);
        const response = await connection.prompt({
          sessionId: session.id,
          prompt: promptBlocks,
        });

        const usage = this.normalizeUsage(response);
        queue.push({
          type: 'complete',
          content: turnState.fullText,
          ...(usage ? { usage } : {}),
          ...(turnState.latestContext ? {
            contextFillTokens: turnState.latestContext.used,
            contextWindow: turnState.latestContext.size,
          } : {}),
          metadata: { stopReason: response.stopReason },
        });
      } catch (error) {
        queue.push({
          type: 'error',
          error: this.isAuthError(error) ? this.authErrorMessage() : this.formatError(error),
        });
      } finally {
        if (turnState.filesEditedThisTurn.size > 0 && this.onTurnFilesEdited) {
          try {
            await this.onTurnFilesEdited(turnState.filesEditedThisTurn, message.sessionId);
          } catch {
            // Best-effort snapshot creation
          }
        }
        abortSignal?.removeEventListener('abort', abortHandler);
        this.activeTurns.delete(session.id);
        queue.finish();
      }
    })();

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      await promptTask;
    }
  }

  abortSession(session: ProtocolSession): void {
    void this.cancelPrompt(session.id);
  }

  cleanupSession(session: ProtocolSession): void {
    this.activeTurns.delete(session.id);
    this.sessionTools.delete(session.id);
    this.sessionStates.delete(session.id);
    this.knownSessionIds.delete(session.id);
    void this.closeSessionAndReleaseProcess(session.id);
  }

  destroy(): void {
    for (const turn of this.activeTurns.values()) {
      turn.queue.finish();
    }
    this.activeTurns.clear();
    this.sessionTools.clear();
    this.sessionStates.clear();
    this.knownSessionIds.clear();
    this.shutdownProcess();
  }

  private buildProtocolSession(
    sessionId: string,
    options: SessionOptions,
    appliedModel: string | undefined,
    deliveredMcpServerCount?: number,
  ): ProtocolSession {
    return {
      id: sessionId,
      platform: this.platform,
      // Report only a model the session is verifiably on; never the request.
      ...(appliedModel ? { appliedModel } : {}),
      ...(deliveredMcpServerCount !== undefined ? { deliveredMcpServerCount } : {}),
      raw: {
        workspacePath: options.workspacePath,
        options,
      },
    };
  }

  private registerSession(sessionId: string): void {
    this.knownSessionIds.add(sessionId);
    if (!this.sessionTools.has(sessionId)) {
      this.sessionTools.set(sessionId, new Map());
    }
    if (!this.sessionStates.has(sessionId)) {
      this.sessionStates.set(sessionId, { availableModels: [], availableModes: [] });
    }
  }

  private captureModes(sessionId: string, modes: SessionModeState | null | undefined): void {
    const state = this.sessionStates.get(sessionId);
    if (!state || !modes) {
      return;
    }
    state.currentMode = modes.currentModeId;
    state.availableModes = modes.availableModes.map((mode) => mode.id);
  }

  /**
   * Put the kimi session into `modeId` unless it is already there or kimi
   * never offered that mode. A refused switch is logged, not fatal: the turn
   * still runs, in whatever mode kimi is in.
   */
  private async applySessionMode(
    connection: ACPClientConnection,
    sessionId: string,
    modeId: string
  ): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (state?.currentMode === modeId) {
      return;
    }
    if (state && state.availableModes.length > 0 && !state.availableModes.includes(modeId)) {
      console.warn(`[KimiACPProtocol] kimi offers no "${modeId}" session mode; leaving mode as is`);
      return;
    }
    try {
      await connection.setSessionMode({ sessionId, modeId });
      if (state) {
        state.currentMode = modeId;
      }
    } catch (error) {
      console.warn('[KimiACPProtocol] session/set_mode failed:', this.formatError(error));
    }
  }

  /**
   * Close the ACP session, then kill the child when no sessions remain so a
   * deleted-session teardown does not leave a `kimi acp` process behind. The
   * next createSession respawns through getConnection().
   */
  private async closeSessionAndReleaseProcess(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (connection) {
      try {
        await connection.closeSession({ sessionId });
      } catch {
        // Best-effort close; the process teardown below still applies.
      }
    }
    if (this.knownSessionIds.size === 0) {
      this.shutdownProcess();
    }
  }

  private shutdownProcess(): void {
    if (this.childProcess && this.onProcessExit) {
      this.childProcess.off('exit', this.onProcessExit);
    }
    this.onProcessExit = null;
    this.childProcess?.kill();
    this.childProcess = null;
    this.connection = null;
    this.initializationPromise = null;
  }

  private async getConnection(): Promise<ACPClientConnection> {
    if (this.connection) {
      return this.connection;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeConnection();
    }
    await this.initializationPromise;

    if (!this.connection) {
      throw new Error('Failed to initialize Kimi ACP connection');
    }

    return this.connection;
  }

  private async initializeConnection(): Promise<void> {
    this.processExitError = null;
    // Scrub after the final merge, never before: a key deleted upstream is
    // merely absent, and absence cannot mask the spread of the parent env.
    const env = scrubProviderApiKeys({ ...(this.processEnv ?? process.env), ...this.extraEnv });

    const child = this.spawnProcess(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: process.cwd(),
    });

    this.childProcess = child;

    // Bounded rolling buffer of recent stderr (kimi logs to stderr; stdout
    // carries the protocol and must stay clean).
    let stderrTail: Buffer = Buffer.alloc(0);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk, STDERR_TAIL_LIMIT_BYTES);
      const text = chunk.toString('utf-8').trim();
      if (text) {
        console.log(`[KimiACPProtocol:stderr] ${text}`);
      }
    });

    child.once('error', (error) => {
      this.processExitError = error;
    });
    // Kept on the instance so destroy()/shutdownProcess() can detach it: a
    // deliberately killed child should not report its own exit as a failure.
    this.onProcessExit = (code, signal) => {
      const stderr = stderrTail.toString('utf-8').trim();
      const exitReason =
        code !== null
          ? `Kimi ACP process exited with code ${code}`
          : `Kimi ACP process exited with signal ${signal ?? 'unknown'}`;
      const message = stderr ? `${exitReason}\nstderr: ${stderr}` : exitReason;
      this.processExitError = new Error(message);
      this.childProcess = null;
      this.connection = null;
      this.initializationPromise = null;
    };
    child.once('exit', this.onProcessExit);

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const connection = new ClientSideConnection(
      () => ({
        requestPermission: (params: RequestPermissionRequest) =>
          this.handlePermissionRequest(params),
        sessionUpdate: (params: SessionNotification) => {
          this.handleSessionUpdate(params);
          return Promise.resolve();
        },
        readTextFile: (params: ReadTextFileRequest) => this.handleReadTextFile(params),
        writeTextFile: (params: WriteTextFileRequest) => this.handleWriteTextFile(params),
      }),
      stream,
    );

    this.connection = connection;

    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'nimbalyst',
          version: '1.0.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: false,
        },
      });
    } catch (error) {
      this.destroy();
      throw new Error(
        `Failed to initialize Kimi ACP agent "${this.command}": ${this.formatError(
          this.processExitError ?? error,
        )}`,
      );
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (params.update.sessionUpdate === 'current_mode_update') {
      // Session state, not turn content: track it whether or not a turn is
      // active so the next applySessionMode compares against the truth.
      const state = this.sessionStates.get(params.sessionId);
      if (state) {
        state.currentMode = params.update.currentModeId;
      }
    }

    const turn = this.activeTurns.get(params.sessionId);
    if (!turn) {
      // No active turn for this session: either a session/load replay or an
      // out-of-turn notification. Never re-emit it as a new stream event.
      return;
    }

    turn.queue.push({
      type: 'raw_event',
      metadata: {
        rawEvent: {
          type: 'session/update',
          sessionId: params.sessionId,
          update: params.update,
        },
      },
    });

    if (params.update.sessionUpdate === 'usage_update') {
      turn.latestContext = params.update;
      turn.queue.push({
        type: 'usage',
        contextFillTokens: params.update.used,
        contextWindow: params.update.size,
      });
      return;
    }

    const mapped = this.mapSessionUpdate(params.sessionId, params.update);
    for (const event of mapped) {
      if (event.type === 'text' && event.content) {
        turn.fullText += event.content;
      }
      turn.queue.push(event);
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const turn = this.activeTurns.get(params.sessionId);
    const toolName = this.deriveToolName(params.toolCall.title ?? 'Tool call', params.toolCall.kind);
    const requestId = params.toolCall.toolCallId;

    turn?.queue.push({
      type: 'raw_event',
      metadata: {
        rawEvent: {
          type: 'session/request_permission',
          sessionId: params.sessionId,
          request: params,
        },
      },
    });

    const toolState = this.createOrUpdateToolState(params.sessionId, requestId, {
      name: toolName,
      title: params.toolCall.title ?? toolName,
      kind: params.toolCall.kind,
      rawInput: params.toolCall.rawInput,
      locations: params.toolCall.locations,
    });

    // Real kimi's permission request names the tool but carries no
    // arguments; the card is announced by the update that brings them.
    if (!toolState.announced && this.hasToolArguments(toolState.rawInput, toolState.locations)) {
      toolState.announced = true;
      turn?.queue.push({
        type: 'tool_call',
        toolCall: {
          id: requestId,
          name: toolState.name,
          arguments: this.mergeLocationPath(
            this.normalizeArguments(toolState.rawInput),
            toolState.locations,
          ),
        },
        metadata: {
          rawEvent: {
            type: 'session/request_permission_preview',
            sessionId: params.sessionId,
            toolCall: params.toolCall,
          },
        },
      });
    }

    const decision = this.onPermissionRequest
      ? await this.onPermissionRequest({
          requestId,
          sessionId: params.sessionId,
          nimbalystSessionId: turn?.nimbalystSessionId,
          toolName,
          toolTitle: params.toolCall.title ?? toolName,
          toolKind: params.toolCall.kind,
          toolInput: params.toolCall.rawInput,
          toolCall: params.toolCall,
          options: params.options,
        })
      : { decision: 'allow' as const, scope: 'once' as const };

    const selectedOption = this.selectPermissionOption(params.options, decision);

    return {
      outcome: {
        outcome: 'selected',
        optionId: selectedOption.optionId,
      },
    };
  }

  private async handleReadTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end =
      typeof params.limit === 'number' && params.limit > 0
        ? start + params.limit
        : lines.length;

    return {
      content: lines.slice(start, end).join('\n'),
    };
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    // Kimi sends the ACP session id on fs requests, so edit correlation is
    // deterministic -- no "latest active turn" guessing.
    const activeTurn = this.activeTurns.get(params.sessionId);
    // kimi spells absolute paths with forward slashes on every platform;
    // history tags and session_files key on native paths.
    const filePath = path.normalize(params.path);

    // Pre-edit hook: capture baseline before writing.
    if (this.onBeforeFileWrite && activeTurn) {
      try {
        await this.onBeforeFileWrite(filePath, activeTurn.nimbalystSessionId);
      } catch {
        // Don't block the write if tagging fails
      }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.content, 'utf-8');

    activeTurn?.filesEditedThisTurn.add(filePath);

    return {};
  }

  private mapSessionUpdate(
    sessionId: string,
    update: SessionUpdate
  ): ProtocolEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.mapContentChunk('text', update.content);
      case 'agent_thought_chunk':
        return this.mapContentChunk('reasoning', update.content);
      case 'tool_call': {
        const toolName = this.deriveToolName(update.title, update.kind);
        const toolState = this.createOrUpdateToolState(sessionId, update.toolCallId, {
          name: toolName,
          title: update.title,
          kind: update.kind,
          rawInput: update.rawInput,
          locations: update.locations,
        });

        // Held until an update carries the arguments (real kimi order).
        if (!this.hasToolArguments(toolState.rawInput, toolState.locations)) {
          return [];
        }
        toolState.announced = true;
        return [this.toolCallEvent(update.toolCallId, toolState)];
      }
      case 'tool_call_update': {
        // A progress title ("Writing new.txt") is display only: the tool name
        // is fixed by the first sight of the call. '' keeps the tracked name;
        // a call first seen here (earlier updates lost) is named from it.
        const existing = this.sessionTools.get(sessionId)?.get(update.toolCallId);
        const toolState = this.createOrUpdateToolState(sessionId, update.toolCallId, {
          name: !existing && update.title ? this.deriveToolName(update.title, update.kind) : '',
          title: update.title ?? '',
          kind: update.kind,
          rawInput: update.rawInput,
          locations: update.locations,
        });

        const isTerminal = update.status === 'completed' || update.status === 'failed';
        const events: ProtocolEvent[] = [];

        // The first update that brings the arguments (or the terminal one,
        // if none did) announces the call.
        if (!toolState.announced && (isTerminal || this.hasToolArguments(toolState.rawInput, toolState.locations))) {
          toolState.announced = true;
          events.push(this.toolCallEvent(update.toolCallId, toolState));
        }

        // Only terminal states surface as tool results.
        if (!isTerminal) {
          return events;
        }

        events.push({
          type: 'tool_result',
          toolResult: {
            id: update.toolCallId,
            name: toolState.name,
            result: this.buildToolResult(update),
          },
        });
        return events;
      }
      default:
        // plan, current_mode_update, and anything new: raw_event only.
        return [];
    }
  }

  private mapContentChunk(
    eventType: 'text' | 'reasoning',
    block: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }>['content']
  ): ProtocolEvent[] {
    if (block.type === 'text') {
      return [{
        type: eventType,
        content: block.text,
      }];
    }

    if (block.type === 'resource_link') {
      return [{
        type: eventType,
        content: block.uri,
      }];
    }

    return [];
  }

  private buildToolResult(update: ToolCallUpdate): ToolResult {
    const status = update.status ?? undefined;
    const normalizedContent = this.normalizeToolContent(update.content);
    const errorText =
      status === 'failed'
        ? this.extractFailureText(update.rawOutput) || this.extractFailureText(normalizedContent)
        : undefined;

    return {
      success: status !== 'failed',
      ...(status ? { status } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
      ...(normalizedContent !== undefined ? { result: normalizedContent } : {}),
    };
  }

  private normalizeToolContent(content: ToolCallContent[] | null | undefined): unknown {
    if (!content || content.length === 0) {
      return undefined;
    }

    return content.map((entry) => {
      if (entry.type === 'content') {
        if (entry.content.type === 'text') {
          return entry.content.text;
        }
        if (entry.content.type === 'resource_link') {
          return entry.content.uri;
        }
        if (entry.content.type === 'image') {
          return {
            type: 'image',
            mimeType: entry.content.mimeType,
            uri: entry.content.uri,
          };
        }
        return entry.content;
      }

      if (entry.type === 'diff') {
        return {
          type: 'diff',
          path: entry.path,
          oldText: entry.oldText ?? null,
          newText: entry.newText,
        };
      }

      if (entry.type === 'terminal') {
        return {
          type: 'terminal',
          terminalId: entry.terminalId,
        };
      }

      return entry;
    });
  }

  private extractFailureText(value: unknown): string | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.extractFailureText(item);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.error === 'string' && record.error.trim()) {
        return record.error;
      }
      if (typeof record.message === 'string' && record.message.trim()) {
        return record.message;
      }
      if (typeof record.result === 'string' && record.result.trim()) {
        return record.result;
      }
    }
    return undefined;
  }

  private createOrUpdateToolState(
    sessionId: string,
    toolCallId: string,
    state: Omit<SessionToolState, 'announced'>
  ): SessionToolState {
    const sessionState = this.sessionTools.get(sessionId) ?? new Map<string, SessionToolState>();
    this.sessionTools.set(sessionId, sessionState);

    const existing = sessionState.get(toolCallId);
    const nextState: SessionToolState = {
      name: state.name || existing?.name || 'Tool call',
      title: state.title || existing?.title || state.name,
      kind: state.kind ?? existing?.kind,
      rawInput: state.rawInput ?? existing?.rawInput,
      locations: state.locations ?? existing?.locations,
      announced: existing?.announced ?? false,
    };

    sessionState.set(toolCallId, nextState);
    return nextState;
  }

  private toolCallEvent(toolCallId: string, toolState: SessionToolState): ProtocolEvent {
    return {
      type: 'tool_call',
      toolCall: {
        id: toolCallId,
        name: toolState.name,
        arguments: this.mergeLocationPath(
          this.normalizeArguments(toolState.rawInput),
          toolState.locations,
        ),
      },
    };
  }

  private hasToolArguments(rawInput: unknown, locations: ToolCallLocation[] | null | undefined): boolean {
    if (locations?.some((loc) => typeof loc?.path === 'string' && loc.path.length > 0)) {
      return true;
    }
    if (rawInput === null || rawInput === undefined) {
      return false;
    }
    if (typeof rawInput === 'object') {
      return Object.keys(rawInput as object).length > 0;
    }
    return true;
  }

  private deriveToolName(title: string, kind?: string | null): string {
    const cleaned = title.trim().replace(/^Tool:\s*/i, '');

    const match = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)/.exec(cleaned);
    if (match) {
      const [, serverName, toolName] = match;
      if (serverName === 'acp_fs') {
        switch (toolName) {
          case 'read_text_file':
            return 'Read';
          case 'write_text_file':
            return 'Write';
          case 'edit_text_file':
          case 'multi_edit_text_file':
            return 'Edit';
          default:
            return toolName;
        }
      }
      return `mcp__${serverName}__${toolName}`;
    }

    // Kimi's tool_call titles already name the tool; the title is the name.
    return cleaned || title || 'Tool call';
  }

  private normalizeArguments(rawInput: unknown): Record<string, unknown> | undefined {
    if (!rawInput) {
      return undefined;
    }
    if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      return KimiACPProtocol.unwrapMcpArguments(rawInput as Record<string, unknown>);
    }
    return { value: rawInput };
  }

  /**
   * Fill `path` from ACP `locations[]` when the tool args don't carry one, so
   * SessionFileTracker / extractFilePath can attribute the edit. Never
   * clobbers a real argument.
   */
  private mergeLocationPath(
    args: Record<string, unknown> | undefined,
    locations: ToolCallLocation[] | null | undefined,
  ): Record<string, unknown> | undefined {
    const firstPath = locations?.find((loc) => typeof loc?.path === 'string' && loc.path.length > 0)?.path;
    if (!firstPath) return args;
    const locationPath = path.normalize(firstPath);

    const base = args ?? {};
    for (const key of ['path', 'file_path', 'filePath'] as const) {
      const value = base[key];
      if (typeof value !== 'string') continue;
      // kimi's rawInput path is relative to the session cwd; the absolute
      // locations[] path is what file tracking can resolve.
      return path.isAbsolute(value) ? base : { ...base, [key]: locationPath };
    }
    return { ...base, path: locationPath };
  }

  /**
   * ACP wraps MCP tool calls as `{ server, tool, arguments }`. Custom widgets
   * key off the inner `arguments` object, so unwrap before handing the args
   * downstream.
   */
  static unwrapMcpArguments(rawInput: Record<string, unknown>): Record<string, unknown> {
    if (
      typeof rawInput.server === 'string' &&
      typeof rawInput.tool === 'string' &&
      rawInput.arguments &&
      typeof rawInput.arguments === 'object' &&
      !Array.isArray(rawInput.arguments)
    ) {
      return rawInput.arguments as Record<string, unknown>;
    }
    return rawInput;
  }

  private normalizeUsage(
    response: { stopReason: string } & { usage?: Usage | null }
  ): ProtocolEvent['usage'] | undefined {
    const usage = response.usage;
    if (!usage) {
      return undefined;
    }
    return {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    };
  }

  private async buildPromptBlocks(message: ProtocolMessage) {
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string; uri?: string }
    > = [];

    blocks.push({
      type: 'text',
      text: message.content,
    });

    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'document' && attachment.filepath) {
        blocks.push({
          type: 'text',
          text: await buildDocumentAttachmentPromptText(attachment),
        });
        continue;
      }

      if (attachment.type !== 'image' || !attachment.filepath) {
        continue;
      }
      const data = await fs.readFile(attachment.filepath);
      blocks.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        uri: `file://${attachment.filepath}`,
      });
    }

    return blocks;
  }

  private async cancelPrompt(sessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    const payload: CancelNotification = { sessionId };
    try {
      await connection.cancel(payload);
    } catch {
      // Best-effort cancellation only.
    }
  }

  /**
   * Record the model picker kimi reports in session/new (and fork) so model
   * application can tell "already on it" from "needs a set_model call".
   */
  private captureConfigOptions(
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined
  ): void {
    if (!configOptions) {
      return;
    }
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return;
    }
    const modelOption = configOptions.find(
      (option) => option.id === 'model' && option.type === 'select'
    );
    if (!modelOption || modelOption.type !== 'select') {
      return;
    }
    state.currentModel = modelOption.currentValue;
    state.availableModels = modelOption.options
      .map((entry) => ('value' in entry ? entry.value : undefined))
      .filter((value): value is string => typeof value === 'string');
  }

  /**
   * Map a Nimbalyst model id onto kimi's ACP alias. `kimi-code:k3` becomes
   * `kimi-code/k3` (first ':' is the registry separator); anything already
   * containing '/' is passed through untouched. Returns undefined for inputs
   * that are not recognizable kimi aliases -- those are not applied at all,
   * since kimi only accepts its full alias strings.
   */
  private static toKimiModelAlias(model: string | undefined): string | undefined {
    if (!model) {
      return undefined;
    }
    const trimmed = model.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.includes('/')) {
      return trimmed;
    }
    const separator = trimmed.indexOf(':');
    if (separator > 0 && separator < trimmed.length - 1) {
      return `${trimmed.slice(0, separator)}/${trimmed.slice(separator + 1)}`;
    }
    return undefined;
  }

  /**
   * Put the requested model onto the kimi session. `session/set_model` is
   * preferred; `session/set_config_option` {configId: "model"} is the
   * fallback. Returns the alias the session verifiably runs -- the requested
   * alias when a setter succeeded, the current alias when no change was
   * needed, undefined when nothing was applied.
   */
  private async applySessionModel(
    connection: ACPClientConnection,
    sessionId: string,
    requestedModel: string | undefined
  ): Promise<string | undefined> {
    const state = this.sessionStates.get(sessionId);
    const current = state?.currentModel;
    const wanted = KimiACPProtocol.toKimiModelAlias(requestedModel);
    if (!wanted) {
      return undefined;
    }
    if (wanted === current) {
      return current;
    }

    try {
      await connection.unstable_setSessionModel({ sessionId, modelId: wanted });
      if (state) {
        state.currentModel = wanted;
      }
      return wanted;
    } catch (setModelError) {
      console.warn('[KimiACPProtocol] session/set_model failed, trying set_config_option:', this.formatError(setModelError));
    }

    try {
      await connection.setSessionConfigOption({
        sessionId,
        configId: 'model',
        value: wanted,
      });
      if (state) {
        state.currentModel = wanted;
      }
      return wanted;
    } catch (configError) {
      console.warn('[KimiACPProtocol] Failed to apply session model:', this.formatError(configError));
      return undefined;
    }
  }

  /**
   * Map a Nimbalyst permission decision onto kimi's option ids
   * (approve_once / approve_always / reject), keyed by kind when a build
   * renames the ids.
   */
  private selectPermissionOption(
    options: PermissionOption[],
    decision: { decision: 'allow' | 'deny'; scope: ToolPermissionScope }
  ): PermissionOption {
    if (decision.decision === 'deny') {
      return (
        options.find((option) =>
          option.optionId === 'reject' ||
          option.kind === 'reject_once' ||
          option.kind === 'reject_always'
        ) ?? options[0]
      );
    }

    if (decision.scope === 'once') {
      return (
        options.find((option) =>
          option.optionId === 'approve_once' ||
          option.kind === 'allow_once'
        ) ?? options[0]
      );
    }

    return (
      options.find((option) =>
        option.optionId === 'approve_always' ||
        option.kind === 'allow_always'
      ) ??
      options.find((option) => option.kind === 'allow_once') ??
      options[0]
    );
  }

  private convertMcpServers(
    mcpServers?: Record<string, MCPServerConfig>
  ): McpServer[] {
    if (!mcpServers) {
      return [];
    }

    const servers: McpServer[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      const cfg = config as Record<string, unknown>;
      if (cfg.url && typeof cfg.url === 'string') {
        const url = cfg.url as string;
        const headers = Object.entries(((cfg.headers ?? cfg.http_headers ?? {}) as Record<string, string>));

        // Kimi takes stdio MCP servers most reliably. Bridge SSE/HTTP servers
        // via mcp-remote spawned as a stdio process.
        //
        // process.execPath inside Electron is the Electron binary itself --
        // spawning it without ELECTRON_RUN_AS_NODE=1 would launch a fresh
        // GUI app per MCP server. The env var makes Electron run as a
        // headless Node process.
        const mcpRemotePath = KimiACPProtocol.resolveMcpRemoteProxy();
        if (mcpRemotePath) {
          const args = [mcpRemotePath, url, '--allow-http'];
          for (const [headerName, value] of headers) {
            args.push('--header', `${headerName}: ${value}`);
          }
          servers.push({
            name,
            command: process.execPath,
            args,
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
          } as McpServer);
        } else {
          // Fallback: pass as SSE/HTTP and hope the agent supports it
          const transport = ((cfg.type ?? cfg.transport ?? '')).toString().toLowerCase();
          const headerArray = headers.map(([headerName, value]) => ({
            name: headerName,
            value,
          }));
          if (transport === 'sse') {
            servers.push({ type: 'sse', name, url, headers: headerArray } as McpServer);
          } else {
            servers.push({ type: 'http', name, url, headers: headerArray } as McpServer);
          }
        }
        continue;
      }

      servers.push({
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {})
          .filter(([, value]) => typeof value === 'string')
          .map(([envName, value]) => ({
            name: envName,
            value,
          })),
      } as McpServer);
    }

    return servers;
  }

  /**
   * Resolve the mcp-remote proxy script, which bridges SSE/HTTP MCP servers
   * to stdio for agents that only support stdio transport.
   */
  private static resolveMcpRemoteProxy(): string | undefined {
    try {
      const require = createRequire(import.meta.url);
      return require.resolve('mcp-remote/dist/proxy.js');
    } catch {
      return undefined;
    }
  }

  private isAuthError(error: unknown): boolean {
    if ((error as { code?: unknown } | null | undefined)?.code === KIMI_AUTH_REQUIRED_CODE) {
      return true;
    }
    return /authrequired|not authenticated|not logged in/i.test(this.formatError(error));
  }

  private authErrorMessage(): string {
    return 'Kimi Code is not logged in. Run `kimi login` in a terminal and complete the device-code sign-in, then retry.';
  }

  private toSessionError(error: unknown, prefix: string): Error {
    if (this.isAuthError(error)) {
      return new Error(this.authErrorMessage());
    }
    return new Error(`${prefix}: ${this.formatError(error)}`);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
