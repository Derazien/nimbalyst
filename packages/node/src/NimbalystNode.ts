/**
 * A headless Nimbalyst node: open the database, register the host, run turns.
 *
 * This is the first consumer of runtime's `node` export condition. It imports
 * only deep `node`-condition subpaths -- never `@nimbalyst/runtime` itself,
 * whose barrel drags in the whole Lexical editor tree and does not exist in
 * `dist-node/` at all.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';

// Host registration is an import side effect and must be ordered first. ESM
// hoists these above the module body, so import position IS the ordering.
import { registerNodeHostEnvironment } from './host/nodeHost.js';

import { SessionManager } from '@nimbalyst/runtime/ai/server/SessionManager';
import { ClaudeCodeProvider } from '@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type { SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { DocumentContext, StreamChunk } from '@nimbalyst/runtime/ai/server/types';

import { registerClaudeCodeDeps } from './host/claudeCodeDeps.js';
import { openDatabase } from './db/openDatabase.js';
import { createNodeSessionStore } from './store/NodeSessionStore.js';
import { createNodeAgentMessagesStore } from './store/NodeAgentMessagesStore.js';
import type { LoadedConfig } from './config.js';

registerNodeHostEnvironment();

export interface RunTurnOptions {
  /** Absolute path to the workspace the agent runs in. Becomes the SDK's cwd. */
  workspacePath: string;
  prompt: string;
  /** Reuse an existing session instead of creating one. */
  sessionId?: string;
  /** Called for every chunk as it streams. */
  onChunk?: (chunk: StreamChunk) => void;
}

export interface RunTurnResult {
  sessionId: string;
  /** Assistant text, concatenated in stream order. */
  text: string;
  /** Tool names in the order they were invoked. */
  toolCalls: string[];
  error?: string;
  /** Rows in `ai_agent_messages` for this session after the turn settled. */
  persistedMessageCount: number;
}

export class NimbalystNode {
  private constructor(
    private readonly db: SqliteDatabase,
    private readonly sessions: SessionManager,
    private readonly sessionStore: SessionStore,
    private readonly config: LoadedConfig,
  ) {}

  static async open(config: LoadedConfig): Promise<NimbalystNode> {
    const { db } = openDatabase(config.resolvedDatabasePath, config.schemaDir);

    // Both repository facades are module-level singletons in the runtime. They
    // must be registered before anything touches session execution: the
    // provider's message writes go through `AgentMessagesRepository` with no
    // other path, and an unregistered store throws
    // "store adapter has not been provided" from deep inside a turn.
    const sessionStore = createNodeSessionStore(db);
    AgentMessagesRepository.setStore(createNodeAgentMessagesStore(db));

    // Passing the store to the constructor also calls `setSessionStore`, which
    // is what `AISessionsRepository` reads.
    const sessions = new SessionManager(sessionStore);
    await sessions.initialize();

    registerClaudeCodeDeps({
      claudeCodePath: config.claudeCodePath,
      trustMode: config.trust?.mode ?? 'bypass-all',
    });

    return new NimbalystNode(db, sessions, sessionStore, config);
  }

  get sessionManager(): SessionManager {
    return this.sessions;
  }

  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    const resolvedSessionId = options.sessionId ?? (await this.sessions.createSession(
      'claude-code',
      undefined,
      options.workspacePath,
      undefined,
      undefined,
      'session',
      'agent',
    )).id;

    // Read the row through the store rather than `SessionManager.loadSession()`.
    //
    // `loadSession` is the natural call and it CANNOT be made from a Node
    // consumer today: it unconditionally calls `loadCanonicalTranscript`, which
    // throws "TranscriptMigrationService not available" unless
    // `TranscriptMigrationRepository.setService(...)` has run -- and runtime's
    // `exports` map has no `node` condition for either
    // `./storage/repositories/TranscriptMigrationRepository` or
    // `./ai/server/transcript/TranscriptMigrationService`, though both are
    // emitted into `dist-node/`. Registering the service is unreachable, so the
    // method is unreachable. Reported; see the session notes.
    //
    // The store gives everything a turn needs. The hydrated `messages` array is
    // for a UI: Claude Code resumes from `providerSessionId`, not from replayed
    // transcript rows.
    const session = await this.sessionStore.get(resolvedSessionId);
    if (!session) {
      throw new Error(`[nimbalyst-node] session ${resolvedSessionId} not found`);
    }

    const provider = new ClaudeCodeProvider();

    // Persisting `providerSessionId` is the HOST's job, not the provider's: the
    // provider only emits it. Without this listener the column stays NULL, and
    // a second turn on the same session silently starts a fresh conversation
    // instead of resuming -- no error, just a model with no memory.
    provider.on('session:providerSessionReceived', (data: {
      sessionId: string;
      providerSessionId: string;
    }) => {
      void this.sessions
        .updateProviderSessionData(data.sessionId, data.providerSessionId)
        .catch((cause: unknown) => {
          console.error('[nimbalyst-node] failed to persist providerSessionId:', cause);
        });
    });

    provider.on('session:providerSessionExpired', (data: { sessionId: string }) => {
      void this.sessions
        .updateProviderSessionData(data.sessionId, undefined)
        .catch((cause: unknown) => {
          console.error('[nimbalyst-node] failed to clear expired providerSessionId:', cause);
        });
    });

    // The other half: hand the stored id back so `options.resume` is populated.
    // The provider's in-memory map is per-instance and this process is one turn
    // long, so it is always empty at this point.
    if (session.providerSessionId) {
      provider.setProviderSessionData(resolvedSessionId, {
        providerSessionId: session.providerSessionId,
        claudeSessionId: session.providerSessionId,
      });

      // Fail loud rather than resume into a fresh conversation.
      const restored = provider.getProviderSessionData(resolvedSessionId);
      const restoredId = restored?.providerSessionId ?? restored?.claudeSessionId;
      if (restoredId !== session.providerSessionId) {
        throw new Error(
          `[nimbalyst-node] provider session restore failed for ${resolvedSessionId}: `
          + `stored "${session.providerSessionId}" but provider reports "${restoredId ?? 'undefined'}"`,
        );
      }
    }

    await provider.initialize({
      // Only ever an explicitly-provisioned key from the config file. Claude
      // Code does not need one -- it authenticates through the CLI's own login
      // -- and nothing here reads `process.env`.
      apiKey: this.config.providerApiKeys?.['claude-code'],
    });

    const documentContext: DocumentContext = {
      mode: 'agent',
      sessionType: session.sessionType ?? 'session',
      hasBeenNamed: session.hasBeenNamed ?? false,
      permissionsPath: options.workspacePath,
      mcpConfigWorkspacePath: options.workspacePath,
      providerSessionId: session.providerSessionId,
    } as DocumentContext;

    const text: string[] = [];
    const toolCalls: string[] = [];
    let error: string | undefined;

    // Streaming chunks are written through a shared coalescing queue with up to
    // 200ms of latency, so a turn can finish with its transcript still in
    // memory. The provider's own turn epilogue drains that queue -- but only on
    // the paths that reach it, which means the generator must be drained to
    // completion. Do not `break` out of this loop; `flushPendingWrites()` is
    // `protected`, so a consumer has no way to drain it from outside.
    for await (const chunk of provider.sendMessage(
      options.prompt,
      documentContext,
      resolvedSessionId,
      [],
      options.workspacePath,
    )) {
      options.onChunk?.(chunk);
      if (chunk.type === 'text' && chunk.content) text.push(chunk.content);
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push(chunk.toolCall.name);
      if (chunk.type === 'error') error = chunk.error ?? 'unknown provider error';
    }

    const persistedMessageCount = Number(
      (this.db
        .prepare('SELECT COUNT(*) AS count FROM ai_agent_messages WHERE session_id = ?')
        .get(resolvedSessionId) as { count: number }).count,
    );

    return {
      sessionId: resolvedSessionId,
      text: text.join(''),
      toolCalls,
      error,
      persistedMessageCount,
    };
  }

  close(): void {
    this.db.close();
  }
}
