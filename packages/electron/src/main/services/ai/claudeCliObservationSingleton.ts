/**
 * Production wiring for the Claude CLI proxy observation backend (NIM-806,
 * Phase 3 / B3). This is the main-process glue that the DI-friendly pieces in
 * `claudeCliObservation/` plug into:
 *
 *   proxy (SSE tee + request body) → ClaudeCliProxyObservation (assemble + dedup)
 *     → bridge (raw `ai_agent_messages` rows) → `ai:message-logged` → transcript reload
 *
 * Exposes `startClaudeCliProxyObservation`, which `ClaudeCliSessionLauncher`
 * calls (via the launcher singleton) to start a per-session proxy before spawn.
 * It returns the `ANTHROPIC_BASE_URL` to point the CLI at and a `stop` to tear
 * the proxy down on PTY exit.
 *
 * What we persist / surface per turn:
 *   - each reassembled ASSISTANT turn (text / thinking / tool_use), deduped by
 *     Anthropic message id inside `ClaudeCliProxyObservation`;
 *   - `tool_result` rows from the next request body, deduped by tool_use_id
 *     (Slice E, `claudeCliToolResultLog.ts`) so the tool cards complete;
 *   - the context-window fill snapshot from each turn's usage (Slice E,
 *     `claudeCliContextUsage.ts`) → `ai:tokenUsageUpdated`.
 *
 * The USER prompt is NOT scraped from the request body — on a real Claude Code
 * turn that trailing user message is the whole injected context (CLAUDE.md,
 * memory, `<system-reminder>`, file context). It's captured at SEND time instead
 * (see `claudeCliUserPromptLog.ts`, fired from `submitClaudeCliPrompt` via the
 * `claude-cli:submit-prompt` IPC).
 */

import { ClaudeCliProxyObservation } from './claudeCliObservation/claudeCliProxyObservation';
import { buildAssistantRawContent } from './claudeCliObservation/claudeCliTranscriptBridge';
import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { broadcastMessageLogged as notifyMessageLogged } from './claudeCliUserPromptLog';
import { logClaudeCliToolResults, loadSeenToolResultIds } from './claudeCliToolResultLog';
import { getSeenToolResultIds, clearSeenToolResultIds } from './claudeCliToolResultSeen';
import {
  clearClaudeCliObserved1mSupport,
  logClaudeCliContextUsage,
  noteClaudeCliObserved1mSupport,
} from './claudeCliContextUsage';
import { classifyClaudeCliUpstreamError } from './claudeCliErrorClassifier';
import { createClaudeCliErrorSurfacePolicy } from './claudeCliErrorSurfacePolicy';
import { logClaudeCliUpstreamError } from './claudeCliErrorLog';
import { extractToolResults } from './claudeCliObservation/claudeApiRequestParser';
import { buildProxyPassthroughEnv } from './claudeCliObservation/proxyPassthroughEnv';
import {
  clearSubAgentTracking,
  getSubagentSpawns,
  hasAnySubagentSpawn,
  noteAssistantSubagentSpawns,
  noteSubagentSpawnResults,
} from './claudeCliSubAgentTracker';
import {
  createClaudeCliSubagentSidecarReader,
  nodeSubagentSidecarFs,
} from './claudeCliSubagentSidecarReader';
import { createAttributedTurnQueue, type AttributedTurnQueue } from './claudeCliAttributedTurnQueue';
import { resolveClaudeCliSubagentsDir } from './claudeCliJsonlPath';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import { trackClaudeCliFileEdits } from './claudeCliFileTracking';
import { sessionFileTracker } from '../SessionFileTracker';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { extractAssistantText, buildTurnNotificationBody } from './claudeCliTurnNotification';
import { buildClaudeCliResponseEvent } from './claudeCliResponseAnalytics';
import {
  recordClaudeCliTurnMessage,
  takeClaudeCliTurnSummary,
  clearClaudeCliTurnSummary,
} from './claudeCliTurnSummary';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { notificationService } from '../NotificationService';
import { composeNotificationTitle } from '../../../shared/notificationTitle';
import { SoundNotificationService } from '../SoundNotificationService';
import { isDesktopTrulyAway } from '../SyncManager';
import { requestMobilePush } from './mobilePushRequest';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { getClaudeCodeApiUpstreamUrl } from '../../utils/store';
import { ClaudeSettingsManager } from '../ClaudeSettingsManager';
import { resolveClaudeCliProxyUpstream } from './claudeCliObservation/proxyUpstream';
import type { AssembledAssistantMessage } from './claudeCliObservation/claudeApiMessageAssembler';

/**
 * Fire the completion sound + "Response Ready" OS notification (+ mobile push when
 * the desktop is truly away) on a CLI turn end, mirroring the SDK path in
 * `MessageStreamingHandler`. Best-effort: never throws into the observation loop.
 */
async function notifyClaudeCliTurnComplete(
  sessionId: string,
  workspacePath: string,
  text: string,
): Promise<void> {
  try {
    SoundNotificationService.getInstance().playCompletionSound(workspacePath);

    const body = buildTurnNotificationBody(text);
    let title = 'claude-code-cli';
    try {
      const session = await AISessionsRepository.get(sessionId);
      title = session?.title || session?.provider || title;
    } catch {
      // best-effort label
    }

    await notificationService.showNotification({
      title: composeNotificationTitle(title, 'Response Ready'),
      body,
      kind: 'agent-complete',
      sessionId,
      workspacePath,
      sourceLabel: title,
      provider: 'claude-code-cli',
    });

    // Mobile push only when the user has truly left the machine (screen
    // locked / idle past threshold) — otherwise the OS notification above
    // already covers it and a push would duplicate via Continuity.
    if (isDesktopTrulyAway()) {
      void requestMobilePush(sessionId, title, body, { reason: 'cli_turn_complete' });
    }
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to fire turn-complete notification:', err);
  }
}

/**
 * Fire the turn-completion side effects (notification, sound, mobile push,
 * `ai_response_received`) ONCE for a fully-completed turn. Called by the launcher
 * on the CLI PID `idle` transition — the authoritative whole-turn boundary that,
 * unlike a proxy `end_turn`, accounts for in-process `Task` sub-agents. No-op when
 * there's no observed summary (terminal-only mode / a turn that produced nothing).
 */
export function fireClaudeCliTurnCompletion(sessionId: string, workspacePath: string): void {
  const summary = takeClaudeCliTurnSummary(sessionId);
  if (!summary) return;
  void notifyClaudeCliTurnComplete(sessionId, workspacePath, summary.lastAssistantText);
  try {
    AnalyticsService.getInstance().sendEvent(
      'ai_response_received',
      buildClaudeCliResponseEvent({ toolNames: summary.toolNames, finalText: summary.lastAssistantText }),
    );
  } catch {
    // analytics is best-effort
  }
}

async function persistAssistantTurn(
  sessionId: string,
  workspacePath: string,
  msg: AssembledAssistantMessage,
  parentToolUseId: string | undefined,
): Promise<void> {
  try {
    await AgentMessagesRepository.create({
      sessionId,
      source: 'claude-code',
      direction: 'output',
      // A sub-agent turn carries the tool_use id that spawned it, so the parser
      // nests it under that agent instead of interleaving it into the lead's
      // transcript. Nothing is hidden any more: an unattributed turn is one we
      // could not identify, and unknown output is shown, not swallowed.
      content: buildAssistantRawContent(msg, { parentToolUseId }),
      hidden: false,
      createdAt: new Date(),
    });
    notifyMessageLogged(sessionId, workspacePath);
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to persist assistant turn:', err);
  }

  // Attribute file edits/reads so the FilesEditedSidebar, context-graph edges,
  // and committed-session detection work for CLI sessions (parity with the SDK,
  // which calls trackToolExecution on every observed tool_call). Result line
  // counts aren't available at tool_use time — that's fine, the SDK tracks here
  // too. Bash-driven edits rely on watcher attribution (not yet wired for CLI).
  try {
    const window = findWindowByWorkspace(workspacePath);
    await trackClaudeCliFileEdits({
      message: msg,
      track: (toolName, input, toolUseId) =>
        sessionFileTracker.trackToolExecution(
          sessionId,
          workspacePath,
          toolName,
          input,
          null,
          toolUseId,
          window,
        ),
    });
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to track file edits:', err);
  }
}

/**
 * Start a proxy observation session for one CLI session. Best-effort: the caller
 * (launcher) tolerates a throw and launches the CLI without observation.
 */
export async function startClaudeCliProxyObservation(opts: {
  sessionId: string;
  workspacePath: string;
  /** The cwd the CLI is launched in. Differs from workspacePath in a worktree. */
  cwd?: string;
}): Promise<{ baseUrl: string; env: Record<string, string>; stop: () => void } | null> {
  const { sessionId, workspacePath } = opts;

  // Sub-agent attribution (see claudeCliSubagentIndex). The sidecars live beside
  // the session jsonl, so the directory is derived from the CLI's own cwd, which
  // is the worktree path rather than the workspace path for a worktree session.
  const subagentsDir = resolveClaudeCliSubagentsDir({
    configDir: resolveClaudeConfigDir(),
    cwd: opts.cwd || workspacePath,
    sessionId,
  });
  const sidecarReader = createClaudeCliSubagentSidecarReader(nodeSubagentSidecarFs());

  // tool_result blocks re-appear in every subsequent request body — dedup so each
  // is persisted once for the lifetime of this observation session (Slice E).
  // Use the SHARED per-session registry so the MCP interactive-prompt settle's
  // synthetic write (which marks the same registry) is already deduped before the
  // proxy scrapes the CLI's echoed tool_result (NIM-806 Defect B). Pre-seed from
  // already-persisted rows so a RESUMED session (`--resume`, BUG 3) doesn't re-log
  // the prior tool_results its first request body replays.
  const seenToolResultIds = getSeenToolResultIds(sessionId);
  for (const id of await loadSeenToolResultIds(sessionId)) {
    seenToolResultIds.add(id);
  }

  // Failed-turn surfacing policy (NIM-808 / NIM-815): collapses retry storms
  // into one transcript row per episode and swallows transient startup errors
  // (cold-connection 429/529 plus a small budget of api_error/generic) until
  // the first visible assistant output. See claudeCliErrorSurfacePolicy.ts.
  const errorSurfacePolicy = createClaudeCliErrorSurfacePolicy();

  // Advanced opt-in: route the CLI's `/v1/messages` through a user-configured
  // loopback upstream (token-compression / gateway / cache) before Anthropic.
  // Undefined → direct to api.anthropic.com (unchanged default). Observation of
  // the ORIGINAL request body / response SSE is unaffected — we only change where
  // the bytes are forwarded.
  // A loopback ANTHROPIC_BASE_URL in Claude's own settings is followed too.
  const { upstreamUrl: apiUpstreamUrl, ignoredClaudeSettingsBaseUrl } = resolveClaudeCliProxyUpstream(
    getClaudeCodeApiUpstreamUrl(),
    await ClaudeSettingsManager.getInstance().getEffectiveEnvValue(workspacePath, 'ANTHROPIC_BASE_URL'),
  );
  if (ignoredClaudeSettingsBaseUrl) {
    console.warn(`[ClaudeCliObservation] not following non-loopback ANTHROPIC_BASE_URL from Claude settings: ${ignoredClaudeSettingsBaseUrl}`);
  }

  // Serial so the row ids the transcript is ordered by follow observation order,
  // even though attribution costs a variable sidecar read per turn.
  // Annotated because the resolver closes over the queue to read its lead ids.
  const turnQueue: AttributedTurnQueue<AssembledAssistantMessage> =
    createAttributedTurnQueue<AssembledAssistantMessage>({
    // Sessions that never spawn an agent skip the sidecar read entirely.
    shouldAttribute: () => hasAnySubagentSpawn(sessionId),
    resolveParentToolUseId: (turn) =>
      sidecarReader.waitForParentToolUseId({
        subagentsDir,
        messageId: turn.messageId,
        spawns: getSubagentSpawns(sessionId),
        // Keeps a fork from claiming the lead turn it forked from.
        leadMessageIds: turnQueue.leadMessageIds(),
      }),
    persist: (turn, parentToolUseId) =>
      persistAssistantTurn(sessionId, workspacePath, turn.message, parentToolUseId),
    onPersisted: (turn, parentToolUseId) => {
      // Only a lead turn counts as visible output for the failure-surfacing
      // policy, and only a lead turn belongs in the "Response Ready" body, so a
      // sub-agent's text and tools do not surface as the session's answer.
      if (parentToolUseId) return;
      errorSurfacePolicy.noteAssistantMessage(true);
      const toolNames = turn.message.content
        .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => b.name);
      recordClaudeCliTurnMessage(sessionId, {
        text: extractAssistantText(turn.message),
        toolNames,
      });
    },
    onError: (error) => {
      console.warn('[ClaudeCliObservation] sub-agent attribution failed:', error);
    },
  });

  const observation = new ClaudeCliProxyObservation({
    sessionId,
    upstreamUrl: apiUpstreamUrl,
    onAssistantMessage: (msg) => {
      // Record this turn's `Agent`/`Task` calls before anything else: a later
      // turn's attribution can depend on a spawn observed in this one.
      noteAssistantSubagentSpawns(sessionId, msg);
      // A produced turn means the session is unblocked, so let the next failure
      // episode surface. Whether it counts as VISIBLE output waits for
      // attribution and is decided in the queue's onPersisted.
      errorSurfacePolicy.noteAssistantMessage(false);
      // Refresh the context-window fill indicator from this turn's usage (Slice E).
      void logClaudeCliContextUsage({ sessionId, usage: msg.usage });
      // Persistence goes through the serial queue so transcript order follows
      // observation order regardless of how long each attribution takes.
      turnQueue.enqueue({ messageId: msg.id, message: msg });
    },
    onRequestBody: (body, info) => {
      // The CLI decides per account + model whether to request the 1M window, and
      // says so in the outbound `anthropic-beta` header. That's the only live
      // context-window signal on this path (the SSE response carries none), so
      // record it to replace the static per-variant guess (NIM-2170).
      noteClaudeCliObserved1mSupport(sessionId, { model: body.model, supports1m: info.context1m });
      // The tee'd SSE only carries the assistant's tool_use calls; the matching
      // tool_results ride in the next request body's trailing user message.
      const results = extractToolResults(body);
      if (results.length > 0) {
        // An `Agent`/`Task` result carries the mailbox handle that ties an
        // in-process teammate to the call that spawned it, so capture it before
        // logging.
        noteSubagentSpawnResults(sessionId, results);
        // Every result is logged now, including a sub-agent's own intermediate
        // ones. They used to be dropped because they would orphan against hidden
        // rows; the rows are no longer hidden, so each result completes the tool
        // card sitting under its agent in the tree.
        void logClaudeCliToolResults({ sessionId, workspacePath, results, seen: seenToolResultIds });
      }
    },
    onError: (err) => {
      console.warn('[ClaudeCliObservation] proxy error:', err.message);
    },
    onRateLimit: ({ statusCode, retryAfter }) => {
      // The SDK path surfaces 429/529 in-stream; the CLI's own TUI shows it too,
      // but the user may be looking at the rich transcript, so raise an OS
      // notification (self-guards on focus/settings).
      console.warn(`[ClaudeCliObservation] upstream rate-limit ${statusCode} for ${sessionId}`, retryAfter ?? '');
      const body =
        statusCode === 529
          ? 'Anthropic is overloaded. Claude will retry shortly.'
          : `Rate limited by Anthropic${retryAfter ? ` (retry after ${retryAfter}s)` : ''}.`;
      void (async () => {
        const session = await AISessionsRepository.get(sessionId).catch(() => null);
        const sourceLabel = session?.title || session?.provider || `Session ${sessionId.slice(0, 8)}`;
        await notificationService.showNotification({
          // A rate-limit pause is the agent stopping until something changes,
          // not a finished turn.
          title: composeNotificationTitle(sourceLabel, 'Claude CLI paused'),
          body,
          kind: 'needs-input',
          sessionId,
          workspacePath,
          sourceLabel,
          provider: 'claude-code-cli',
        });
      })().catch(() => {});
    },
    onUpstreamError: ({ statusCode, body, retryAfter }) => {
      // Render a failed turn IN the rich transcript so a rate-limited / failed
      // turn is a visible "paused"/"failed" state, not a silent hang (NIM-808).
      const failure = classifyClaudeCliUpstreamError({ statusCode, body, retryAfter });
      if (!failure) return;

      if (!errorSurfacePolicy.shouldSurface(failure)) {
        console.warn(
          `[ClaudeCliObservation] suppressed upstream ${failure.kind} (${failure.statusCode}) for ${sessionId} (startup-transient or same-episode retry)`
        );
        return;
      }

      void logClaudeCliUpstreamError({ sessionId, workspacePath, failure });
    },
  });

  const { baseUrl } = await observation.start();
  // Sitting on ANTHROPIC_BASE_URL makes the CLI read us as an inference gateway
  // and withhold first-party-only behavior, which breaks WebSearch/WebFetch at
  // effort `max`. Declare the proxy first-party, but only when it really
  // does forward to Anthropic. See proxyPassthroughEnv.ts.
  const env = buildProxyPassthroughEnv(apiUpstreamUrl);
  console.log(`[ClaudeCliObservation] proxy started for ${sessionId} at ${baseUrl}`);
  return {
    baseUrl,
    env,
    stop: () => {
      observation.stop();
      // Drop the per-session seen-set so a later relaunch re-seeds from the DB.
      clearSeenToolResultIds(sessionId);
      clearClaudeCliTurnSummary(sessionId);
      clearSubAgentTracking(sessionId);
      clearClaudeCliObserved1mSupport(sessionId);
    },
  };
}
