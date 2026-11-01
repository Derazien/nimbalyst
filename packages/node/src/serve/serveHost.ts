/**
 * The transport-independent half of `serve`: open the node with synced
 * stores, build the serve runtime, subscribe it to a `SyncProvider`, recover
 * the persisted queue.
 *
 * Split out of `startServe.ts` (#416) so the cloud room and the local
 * transport run the same create-session claim, queue drain and
 * no-replay-after-restart code. A transport only decides how the provider is
 * built, how it authenticates and when it is eligible for work.
 */

import {
  createMessageSyncHandler,
  createSyncedSessionStore,
} from '@nimbalyst/runtime/sync/SyncedSessionStore';
import type { SyncProvider } from '@nimbalyst/runtime/sync/types';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type {
  AIProviderType,
  AgentRole,
  SessionType,
} from '@nimbalyst/runtime/ai/server/types';

import { NimbalystNode } from '../NimbalystNode.js';
import type { LoadedConfig } from '../config.js';
import type { Logger } from './log.js';
import { createQueuedPromptStore } from './queuedPrompts.js';
import type { CheckoutOutcome } from './repoCheckout.js';
import { createServeRuntime, type RunTurnInput, type ServeRuntime } from './serveRuntime.js';
import {
  createSyncedAgentMessagesStore,
  type FlushableAgentMessagesStore,
} from './syncedAgentMessagesStore.js';
import { withHostAttribution } from './hostAttributionStore.js';
import type { WorkspaceMapping } from './workspaces.js';
import { readWorkspaceContext, expandRemoteCommand } from './workspaceContext.js';
import { stageRemoteAttachments } from './remoteAttachments.js';

export interface ServeWorkspaces {
  loadWorkspaces(projectId: string): WorkspaceMapping[];
  ensureCheckout(mapping: WorkspaceMapping): Promise<CheckoutOutcome>;
  confineCheckout(mapping: WorkspaceMapping): string;
}

export interface ServeHostOptions {
  config: LoadedConfig;
  log: Logger;
  /** The id this node announces; requests target it and sessions carry it. */
  deviceId: string;
  provider: SyncProvider;
  /** Decrypts attachments and encrypts the workspace context. */
  encryptionKey: import("node:crypto").webcrypto.CryptoKey;
  workspaces: ServeWorkspaces;
  connectionGeneration(): number;
  /**
   * Replaces `NimbalystNode.runTurn` for tests that must not spawn `claude`.
   * Production callers leave it unset.
   */
  runTurnOverride?: (node: NimbalystNode, input: RunTurnInput) => Promise<{ error?: string }>;
}

export interface ServeHost {
  node: NimbalystNode;
  runtime: ServeRuntime;
  /** Stops intake at the source; handed to `shutdownServe`. */
  unsubscribes: Array<() => void>;
}

export async function openServeHost(options: ServeHostOptions): Promise<ServeHost> {
  const { config, log, deviceId, provider, encryptionKey, workspaces } = options;
  const messageSync = createMessageSyncHandler(provider);
  let transcripts: FlushableAgentMessagesStore | undefined;

  const node = await NimbalystNode.open(config, {
    // Outermost, so `hostDeviceId` is in the payload the synced store publishes
    // from -- not stamped afterwards, where a failure leaves the session
    // permanently unattributed. See hostAttributionStore.ts.
    decorateSessionStore: (store) =>
      withHostAttribution(createSyncedSessionStore(store, provider), deviceId),
    decorateAgentMessagesStore: (store) => {
      transcripts = createSyncedAgentMessagesStore(store, messageSync, log);
      return transcripts;
    },
  });

  const queue = createQueuedPromptStore(node.database);

  const runtime = createServeRuntime({
    deviceId,
    sync: provider,
    log,
    queue,
    loadWorkspaces: workspaces.loadWorkspaces,
    ensureCheckout: workspaces.ensureCheckout,
    confineCheckout: workspaces.confineCheckout,
    connectionGeneration: options.connectionGeneration,
    flushTranscripts: (timeoutMs) => transcripts?.flushPending(timeoutMs) ?? Promise.resolve(0),

    noteFailed: async (sessionId, prompt, error) => {
      await AgentMessagesRepository.create({
        sessionId, source: 'system', direction: 'output',
        content: JSON.stringify({type: 'system', text: `The remote turn could not start: ${error}. Correct the problem and send the prompt again.`, prompt: prompt.slice(0, 500)}),
        messageKind: 'system', createdAt: new Date(), searchable: false,
      });
    },

    noteInterrupted: async (sessionId, prompt) => {
      // Written through the decorated store, so it reaches the session room the
      // same way any other transcript row does. Without it the requester sees a
      // prompt that simply stopped, with nothing saying why.
      await AgentMessagesRepository.create({
        sessionId,
        source: 'system',
        direction: 'output',
        content: JSON.stringify({
          type: 'system',
          text: 'This prompt was interrupted when the remote node stopped, and was not re-run. '
            + 'Send it again if you still want it.',
          prompt: prompt.slice(0, 500),
        }),
        messageKind: 'system',
        createdAt: new Date(),
        searchable: false,
      });
    },

    createSession: async (input) => {
      const session = await node.sessionManager.createSession(
        input.provider as AIProviderType,
        undefined,
        // The REQUESTER's workspace path, so the index entry files this session
        // under the project the user actually has open.
        input.projectId,
        undefined,
        input.model,
        (input.sessionType ?? 'session') as SessionType,
        'agent',
        undefined,
        undefined,
        undefined,
        (input.agentRole ?? 'standard') as AgentRole,
      );

      // Host attribution, through the synced store so it reaches the index.
      // Bookkeeping past the point of no return: the session exists either way,
      // so a failure here is logged, not surfaced as "creation failed".
      try {
        await node.store.updateMetadata(session.id, {
          ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
          metadata: { hostDeviceId: input.hostDeviceId },
        });
      } catch (error) {
        log('host-attribution-failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Publish a complete index entry, the way the desktop does after creating
      // a session for a remote request. `syncSessionsToIndex` builds a FRESH
      // entry from this payload, so every field the requester needs on first
      // sight has to be present here -- `parentSessionId` and `hostDeviceId`
      // included, or the write above is clobbered by this one.
      provider.syncSessionsToIndex?.([{
        id: session.id,
        title: session.title ?? 'Untitled',
        provider: session.provider,
        model: session.model,
        mode: session.mode,
        sessionType: session.sessionType,
        agentRole: session.agentRole,
        parentSessionId: input.parentSessionId ?? session.parentSessionId ?? undefined,
        hostDeviceId: input.hostDeviceId,
        createdBySessionId: session.createdBySessionId ?? undefined,
        // Both are the REQUESTER's path. This is what groups the session under
        // their project instead of under this node's checkout directory.
        workspaceId: input.projectId,
        workspacePath: input.projectId,
        messageCount: 0,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      }]);

      return { id: session.id };
    },

    getSessionProjectId: async (sessionId) => {
      const session = await node.store.get(sessionId);
      return session?.workspacePath ?? null;
    },

    workspaceContext: async workspace => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, encryptionKey, new TextEncoder().encode(JSON.stringify(await readWorkspaceContext(workspace))));
      return {encrypted: Buffer.from(encrypted).toString('base64'), iv: Buffer.from(iv).toString('base64')};
    },
    runTurn: async (input) => {
      if (options.runTurnOverride) return options.runTurnOverride(node, input);
      const staged = await stageRemoteAttachments(input.attachments, encryptionKey);
      try {
      const result = await node.runTurn({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        prompt: await expandRemoteCommand(input.prompt, input.workspacePath),
        attachments: staged.attachments,
        options: input.options,
        onTurnStarted: input.onTurnStarted,
      });
      return { error: result.error };
      } finally { await staged.dispose(); }
    },
  });

  const unsubscribes: Array<() => void> = [];
  unsubscribes.push(
    // Every reconnect, not just the ones this process initiates. A transcript
    // row that could not be sent is retried when a socket is usable again --
    // hooking only the twelve-minute rotation left a row stranded for up to
    // twelve minutes after a blip that lasted seconds.
    provider.onConnectionGenerationChange?.((generation) => {
      void (async () => {
        if (!transcripts || transcripts.failedCount() === 0) return;
        const stillFailed = await transcripts.retryFailed();
        log('transcript-retried', { generation, stillFailed });
      })();
    }) ?? (() => {}),
    provider.onCreateSessionRequest?.((request) => {
      void runtime.handleCreateSessionRequest(request);
    }) ?? (() => {}),
    provider.onIndexChange?.((sessionId, entry) => {
      void runtime.handleIndexChange(sessionId, entry);
    }) ?? (() => {}),
    provider.onSessionControlMessage?.((message) => {
      void runtime.handleSessionControlMessage(message);
    }) ?? (() => {}),
  );

  // Work the previous process did not finish. A broadcast can already be
  // arriving by now, which is fine: drains are serialized per session and the
  // claim is an atomic status transition, so a recovered prompt and a fresh one
  // queue behind each other rather than racing.
  await runtime.recoverPersistedQueue();

  return { node, runtime, unsubscribes };
}
