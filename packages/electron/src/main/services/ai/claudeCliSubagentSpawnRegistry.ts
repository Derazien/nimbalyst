/**
 * Per-session registry of the `Agent`/`Task` calls a `claude-code-cli` session
 * made, with the launch details the wire carries (prompt, description, type,
 * model, run_in_background).
 *
 * ## Why this exists
 *
 * Attributing a sub-agent turn through the CLI's sidecar files means waiting for
 * a file the CLI writes on its own schedule, and a bounded wait that expires
 * persists the turn as the LEAD's, leaking a background agent's output into the
 * main conversation. The wire already says who is asking, one request earlier:
 * the first user message of a sub-agent's API request IS the prompt the parent
 * passed in the `Agent` tool_use input. Matching that prompt against the spawns
 * observed so far attributes the request immediately, with no file involved.
 * The sidecar lookup stays as the second source for what this cannot decide.
 *
 * ## What it refuses to decide
 *
 * A wrong attribution nests the lead's output under an agent, which is worse than
 * the leak, so the match is conservative:
 *   - a body that contains the spawn's own `tool_use` is the lead (or a fork
 *     replaying the lead's history), never the agent that call produced;
 *   - several spawns matching the same prompt (a fan-out with one prompt) is
 *     ambiguous and left to the sidecar;
 *   - an exact match beats a prefix match, because the CLI may append to the prompt.
 *
 * Pure and dependency-free apart from the shared spawn-tool-name predicate.
 */

import { isBackgroundLaunchAcknowledgement } from '@nimbalyst/runtime/ai/server/providers/claudeCode/subagentDrain';
import { isSubagentToolName, parseAgentHandlesFromToolResult } from './claudeCliSubagentIndex';

export interface SubagentSpawnInfo {
  /** The `Agent`/`Task` tool_use id. */
  toolUseId: string;
  /** Prompt passed to the agent; empty when the call carried none. */
  prompt: string;
  description?: string;
  subagentType?: string;
  model?: string;
  runInBackground: boolean;
}

export interface SubagentSpawnRegistry {
  /** Record any `Agent`/`Task` blocks among these content blocks. Idempotent per id. */
  noteToolUses(blocks: ReadonlyArray<unknown> | undefined): void;
  /**
   * Record the spawns replayed in a request's assistant history. After a resume
   * the live stream has not shown them again, so this is the only place a resumed
   * session learns its earlier spawns.
   */
  noteRequestHistory(body: Record<string, unknown>): void;
  get(toolUseId: string): SubagentSpawnInfo | undefined;
  list(): SubagentSpawnInfo[];
  /**
   * The tool_use ids among these results that are only the launch acknowledgement
   * of a background agent (still running), as opposed to its real result. Needs the
   * spawn to be known and either flagged `run_in_background` or naming its output
   * file, so a foreground result that merely mentions the background still completes.
   */
  backgroundLaunchAcks(results: ReadonlyArray<{ toolUseId: string; content?: string | null }>): Set<string>;
  /**
   * The spawn whose prompt opens this request, or undefined when it is not (or
   * not provably) a sub-agent's request.
   */
  matchRequest(body: Record<string, unknown>): string | undefined;
}

interface BlockLike {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
}

const LEADING_REMINDERS = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Drop reminder blocks the CLI prepends to the first user message. */
function stripLeadingReminders(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(LEADING_REMINDERS, '');
    if (next === out) return out;
    out = next;
  }
}

function asMessages(body: Record<string, unknown>): MessageLike[] {
  return Array.isArray(body.messages) ? (body.messages as MessageLike[]) : [];
}

/** Normalized texts the first user message could be matched as. */
function firstUserMessageCandidates(body: Record<string, unknown>): string[] {
  const first = asMessages(body).find((m) => m?.role === 'user');
  if (!first) return [];
  const raw: string[] = [];
  if (typeof first.content === 'string') {
    raw.push(first.content);
  } else if (Array.isArray(first.content)) {
    const texts = (first.content as BlockLike[])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => stripLeadingReminders(b.text as string))
      .filter((t) => t.trim().length > 0);
    raw.push(...texts);
    if (texts.length > 1) raw.push(texts.join('\n'));
  }
  return raw.map((t) => normalize(stripLeadingReminders(t))).filter((t) => t.length > 0);
}

/** tool_use ids the request's assistant history already contains. */
function assistantToolUseIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const message of asMessages(body)) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content as BlockLike[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') ids.add(block.id);
    }
  }
  return ids;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function createSubagentSpawnRegistry(): SubagentSpawnRegistry {
  const spawns = new Map<string, SubagentSpawnInfo>();
  const normalizedPrompts = new Map<string, string>();

  function noteToolUses(blocks: ReadonlyArray<unknown> | undefined): void {
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      const block = raw as BlockLike;
      if (block?.type !== 'tool_use' || !isSubagentToolName(block.name)) continue;
      if (typeof block.id !== 'string' || !block.id || spawns.has(block.id)) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      spawns.set(block.id, {
        toolUseId: block.id,
        prompt,
        description: str(input.description),
        subagentType: str(input.subagent_type),
        model: str(input.model),
        runInBackground: input.run_in_background === true,
      });
      normalizedPrompts.set(block.id, normalize(prompt));
    }
  }

  return {
    noteToolUses,
    noteRequestHistory(body) {
      for (const message of asMessages(body)) {
        if (message?.role === 'assistant') noteToolUses(message.content as ReadonlyArray<unknown>);
      }
    },
    backgroundLaunchAcks(results) {
      const acks = new Set<string>();
      for (const { toolUseId, content } of results) {
        const spawn = spawns.get(toolUseId);
        if (!spawn || !content || !isBackgroundLaunchAcknowledgement(content)) continue;
        if (spawn.runInBackground || parseAgentHandlesFromToolResult(content).outputFileAgentId) acks.add(toolUseId);
      }
      return acks;
    },
    get: (toolUseId) => spawns.get(toolUseId),
    list: () => [...spawns.values()],
    matchRequest(body) {
      if (spawns.size === 0) return undefined;
      const candidates = firstUserMessageCandidates(body);
      if (candidates.length === 0) return undefined;
      const ownHistory = assistantToolUseIds(body);

      const exact: string[] = [];
      const prefix: string[] = [];
      for (const [toolUseId, prompt] of normalizedPrompts) {
        if (!prompt || ownHistory.has(toolUseId)) continue;
        if (candidates.some((c) => c === prompt)) exact.push(toolUseId);
        else if (candidates.some((c) => c.startsWith(prompt))) prefix.push(toolUseId);
      }
      if (exact.length === 1) return exact[0];
      if (exact.length === 0 && prefix.length === 1) return prefix[0];
      return undefined;
    },
  };
}
