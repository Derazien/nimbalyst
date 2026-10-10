/**
 * Background sub-agent completion for the `claude-code-cli` observation path.
 *
 * A background agent's `Agent` tool_result is only a launch acknowledgement. When
 * the agent finishes, fails or is stopped, the CLI injects a `<task-notification>`
 * block into the next request's user message:
 *
 *   <task-notification>
 *   <task-id>a8b6107638119d9d6</task-id>
 *   <tool-use-id>toolu_01Q3…</tool-use-id>
 *   <output-file>…\tasks\a8b6107638119d9d6.output</output-file>
 *   <status>completed</status>            (completed | failed | killed | stopped)
 *   <summary>Agent "Implement" finished</summary>
 *   <note>…</note>                        (agents only; the same task id can notify again)
 *   <result>…the agent's final text…</result>
 *   </task-notification>
 *
 * (Shape taken from real session transcripts; `tool-use-id` and `result` are absent
 * on some notifications.) This is the only completion signal the proxy can see, so
 * it is turned into one `nimbalyst_subagent_completion` raw row per notification,
 * which `ClaudeCodeRawParser` reads into `subagent_completed`.
 *
 * The block is re-sent in every later request's history, so each notification is
 * deduped by an identity key, seeded from persisted rows so a `--resume` replay does
 * not log it again.
 */

import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { broadcastMessageLogged } from './claudeCliUserPromptLog';
import {
  parseAgentHandlesFromToolResult,
  type ClaudeCliAgentSpawn,
} from './claudeCliSubagentIndex';

export type SubagentCompletionStatus = 'completed' | 'failed' | 'stopped';

export interface ParsedTaskNotification {
  taskId?: string;
  /** Present on agent and shell notifications alike; only agents resolve to a spawn. */
  toolUseId?: string;
  outputFile?: string;
  status: SubagentCompletionStatus;
  summary: string;
  result?: string;
  /** Identity of this notification across the requests that replay it. */
  key: string;
}

/** Cap on the result text stored in a completion row (the parser keeps far less). */
const MAX_RESULT_CHARS = 2000;
const NOTIFICATION_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function field(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/** The CLI's task states folded onto the transcript's three terminal ones. */
function mapStatus(raw: string | undefined): SubagentCompletionStatus | undefined {
  switch (raw?.toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'stopped';
    default:
      return undefined;
  }
}

function userTexts(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const texts: string[] = [];
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    }
  }
  return texts;
}

/**
 * Every terminal task notification in the request's user messages. History is
 * scanned, not just the trailing message: the CLI may absorb a notification
 * mid-turn, so it is not always the newest message.
 */
export function extractTaskNotifications(body: Record<string, unknown>): ParsedTaskNotification[] {
  const found: ParsedTaskNotification[] = [];
  for (const text of userTexts(body)) {
    if (!text.includes('<task-notification>')) continue;
    for (const match of text.matchAll(NOTIFICATION_BLOCK)) {
      const block = match[1];
      const status = mapStatus(field(block, 'status'));
      const taskId = field(block, 'task-id');
      if (!status || !taskId) continue;
      const summary = field(block, 'summary') ?? '';
      const result = field(block, 'result');
      found.push({
        taskId,
        toolUseId: field(block, 'tool-use-id'),
        outputFile: field(block, 'output-file'),
        status,
        summary,
        result,
        key: [taskId, status, summary, (result ?? '').slice(0, 200)].join('|'),
      });
    }
  }
  return found;
}

/** `ai_agent_messages.content` for one completion. See the file header for the source. */
export function buildSubagentCompletionContent(
  notification: ParsedTaskNotification,
  spawnToolUseId: string,
): string {
  return JSON.stringify({
    type: 'nimbalyst_subagent_completion',
    tool_use_id: spawnToolUseId,
    status: notification.status,
    summary: notification.summary,
    ...(notification.result ? { result: notification.result.slice(0, MAX_RESULT_CHARS) } : {}),
    ...(notification.taskId ? { task_id: notification.taskId } : {}),
    ...(notification.outputFile ? { output_file: notification.outputFile } : {}),
    notification_key: notification.key,
  });
}

/**
 * The spawn a notification belongs to: by the spawning tool_use id when the block
 * carries it, else through the agent id the spawn's own tool_result reported as
 * `tasks/<agentId>.output`.
 */
export function resolveNotificationSpawn(
  notification: ParsedTaskNotification,
  spawns: ReadonlyArray<ClaudeCliAgentSpawn>,
): string | undefined {
  if (notification.toolUseId && spawns.some((s) => s.toolUseId === notification.toolUseId)) {
    return notification.toolUseId;
  }
  const agentIds = new Set<string>();
  if (notification.taskId) agentIds.add(notification.taskId);
  const fromPath = parseAgentHandlesFromToolResult(notification.outputFile).outputFileAgentId;
  if (fromPath) agentIds.add(fromPath);
  for (const spawn of spawns) {
    const handle = parseAgentHandlesFromToolResult(spawn.resultText).outputFileAgentId;
    if (handle && agentIds.has(handle)) return spawn.toolUseId;
  }
  return undefined;
}

/** Notification keys of completion rows already on disk (restart / `--resume` guard). */
export function extractPersistedCompletionKeys(rows: Array<{ content: string }>): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row?.content || !row.content.includes('nimbalyst_subagent_completion')) continue;
    try {
      const parsed = JSON.parse(row.content) as { type?: unknown; notification_key?: unknown };
      if (parsed?.type === 'nimbalyst_subagent_completion' && typeof parsed.notification_key === 'string') {
        keys.add(parsed.notification_key);
      }
    } catch {
      // not our row
    }
  }
  return keys;
}

export async function loadSeenCompletionKeys(sessionId: string): Promise<Set<string>> {
  try {
    const rows = await AgentMessagesRepository.list(sessionId, { includeHidden: true });
    return extractPersistedCompletionKeys(rows);
  } catch (err) {
    console.warn('[ClaudeCliTaskNotifications] Failed to pre-seed seen completion keys:', err);
    return new Set<string>();
  }
}

export interface SubagentCompletionLoggerDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'output';
    content: string;
    hidden: boolean;
    createdAt: Date;
  }) => Promise<unknown>;
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
  now: () => Date;
}

const productionDeps: SubagentCompletionLoggerDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: broadcastMessageLogged,
  now: () => new Date(),
};

export interface SubagentCompletionLogger {
  /**
   * Persist a completion row for each not-yet-seen notification in the request
   * that resolves to a known spawn. Returns how many rows were written. A
   * notification that does not resolve yet (a background shell, or an agent whose
   * launch result has not been seen) is not marked seen, so a later request retries.
   */
  log(body: Record<string, unknown>, spawns: ReadonlyArray<ClaudeCliAgentSpawn>): Promise<number>;
}

export function createSubagentCompletionLogger(input: {
  sessionId: string;
  workspacePath: string;
  /** Caller-owned notification keys already persisted. */
  seen: Set<string>;
  deps?: SubagentCompletionLoggerDeps;
}): SubagentCompletionLogger {
  const deps = input.deps ?? productionDeps;
  return {
    async log(body, spawns) {
      let written = 0;
      for (const notification of extractTaskNotifications(body)) {
        if (input.seen.has(notification.key)) continue;
        const spawnToolUseId = resolveNotificationSpawn(notification, spawns);
        if (!spawnToolUseId) continue;
        try {
          await deps.createMessage({
            sessionId: input.sessionId,
            source: 'claude-code',
            direction: 'output',
            content: buildSubagentCompletionContent(notification, spawnToolUseId),
            hidden: false,
            createdAt: deps.now(),
          });
          input.seen.add(notification.key);
          written += 1;
        } catch (err) {
          console.warn('[ClaudeCliTaskNotifications] Failed to persist sub-agent completion:', err);
        }
      }
      if (written > 0) deps.notifyMessageLogged(input.sessionId, input.workspacePath);
      return written;
    },
  };
}
