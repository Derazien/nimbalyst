/**
 * Exact sub-agent attribution for the `claude-code-cli` proxy-observation path.
 *
 * ## Why this exists
 *
 * `ClaudeCodeRawParser` already builds the whole sub-agent tree: an `Agent`/`Task`
 * tool_use becomes a `subagent_started` node, and any later event carrying
 * `parent_tool_use_id` for that id is nested underneath it. That is how the
 * Agent-SDK path (`claude-code`) renders per-agent tool calls today.
 *
 * The CLI path never feeds it. The B3 proxy observes raw `/v1/messages` traffic,
 * which has no `parent_tool_use_id`: the CLI runs sub-agents in-process and their
 * API calls are independent requests on the same loopback proxy, indistinguishable
 * per-request from the lead's. `claudeCliSubAgentTracker` could only answer "is
 * SOME sub-agent running", which is useless once several run at once.
 *
 * The CLI does, however, write a per-agent sidecar next to the session jsonl:
 *
 *   <claude config>/projects/<encoded-cwd>/<sessionId>/subagents/
 *     agent-<agentId>.jsonl        full sub-agent transcript
 *     agent-<agentId>.meta.json    written at spawn
 *
 * Those sidecar assistant entries carry the SAME Anthropic `message.id` (`msg_…`)
 * the proxy sees on the wire. That is the join: an observed message id identifies
 * its agent exactly, and the agent's meta identifies the tool_use that spawned it.
 * This module is that join table.
 *
 * ## Resolving an agent to the tool_use that spawned it
 *
 * Measured against a real 56-agent session (2026-08-23), the sidecar file name is
 * NOT the spawning tool_use id — zero of twenty matched. Two disjoint populations
 * exist, and between them they cover every agent:
 *
 *   - Plain sub-agents (20/56) carry `meta.toolUseId`, which IS the spawning id.
 *     This holds at every nesting depth, so a nested agent resolves even though
 *     its spawn lives inside another agent's sidecar rather than the main
 *     transcript.
 *   - In-process teammates (36/56) carry no `toolUseId`, but carry `name` and
 *     `teamName`. The spawning `Agent` tool_result text ends with
 *     `agent_id: <name>@<teamName>`, so the pair identifies the spawn.
 *
 * A third route (`tasks/<agentId>.output` in the tool_result of a backgrounded
 * agent) is kept as a fallback because it costs nothing and covers a shape the
 * other two would miss.
 *
 * Dependency-free and pure: the filesystem read lives at the call site, so every
 * rule here unit-tests without touching disk.
 */

/** Tool names that spawn a sub-agent. `Agent` replaced `Task` in CLI 2.1.63. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** True for a tool name that spawns a sub-agent, under either spelling. */
export function isSubagentToolName(name: string | undefined): boolean {
  return !!name && SUBAGENT_TOOL_NAMES.has(name);
}

/** Contents of `agent-<agentId>.meta.json`. Every field is optional by shape. */
export interface ClaudeCliSubagentMeta {
  agentType?: string;
  description?: string;
  /** The spawning `Agent`/`Task` tool_use id. Absent on in-process teammates. */
  toolUseId?: string;
  /** Set when this agent was spawned from inside another agent. */
  parentAgentId?: string;
  spawnDepth?: number;
  name?: string;
  teamName?: string;
  taskKind?: string;
  model?: string;
  color?: string;
  permissionMode?: string;
  planModeRequired?: boolean;
  isFork?: boolean;
}

/** One sidecar, as read from disk by the caller. */
export interface ClaudeCliSubagentSidecar {
  /** Agent id parsed out of the file name (equals `entry.agentId` on every row). */
  agentId: string;
  meta: ClaudeCliSubagentMeta | null;
  /** Anthropic `msg_…` ids seen on this sidecar's assistant entries. */
  messageIds: readonly string[];
}

/** An observed `Agent`/`Task` tool call, with its result text once it lands. */
export interface ClaudeCliAgentSpawn {
  toolUseId: string;
  /** Flattened text of the tool_result, when it has been observed. */
  resultText?: string | null;
}

/**
 * A fork (`agentType: 'fork'`, `isFork: true`) starts from a point in the lead's
 * conversation and inherits the turn it forked from, stamped with the fork's own
 * `agentId`. Measured on the reference session: three forks, and each one's
 * sidecar opens with a message the LEAD also produced, at index 0 every time.
 *
 * Attributing that turn to the fork would nest the lead's own output under an
 * agent node and lose it from the top level, which is the exact defect this file
 * exists to remove, only mirrored. So the lead always wins a contested id, and a
 * fork never displaces a non-fork claim.
 */
function isForkMeta(meta: ClaudeCliSubagentMeta | null | undefined): boolean {
  return meta?.isFork === true || meta?.agentType === 'fork';
}

/** Read-only join table over one session's sub-agents. */
export interface ClaudeCliSubagentIndex {
  /** Number of agents known to this index. */
  readonly agentCount: number;
  /** Which agent produced this observed message, if any. */
  agentIdForMessageId(messageId: string): string | undefined;
  /** The `Agent`/`Task` tool_use id that spawned this agent, if resolvable. */
  spawnToolUseIdForAgentId(agentId: string): string | undefined;
  /**
   * The agent a spawning tool_use id produced, i.e. the inverse of
   * `spawnToolUseIdForAgentId`. This is what turns a transcript node (keyed by
   * tool_use id) back into a sidecar file name.
   */
  agentIdForSpawnToolUseId(toolUseId: string): string | undefined;
  /**
   * The value to write as `parent_tool_use_id` on an observed turn, which is what
   * `ClaudeCodeRawParser` needs to nest it under its agent. Undefined means the
   * turn is either the lead's or not yet attributable.
   */
  parentToolUseIdForMessageId(messageId: string): string | undefined;
  metaForAgentId(agentId: string): ClaudeCliSubagentMeta | undefined;
}

/**
 * Parse the agent id out of a sidecar file name. Accepts both the transcript and
 * the meta file. Returns null for anything else in the directory.
 *
 * Ids are opaque: plain agents look like `a1bdea681b7e11123`, named teammates
 * like `aarch-deck-483ae151b77d91ac`, and compaction agents like
 * `acompact-<hash>`. Nothing downstream parses their internals.
 */
export function parseSubagentIdFromFileName(fileName: string): string | null {
  if (!fileName.startsWith('agent-')) return null;
  for (const suffix of ['.meta.json', '.jsonl']) {
    if (fileName.endsWith(suffix)) {
      const id = fileName.slice('agent-'.length, -suffix.length);
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/** A sidecar jsonl row, narrowed to the fields attribution needs. */
interface SidecarEntryLike {
  type?: string;
  agentId?: string;
  message?: { id?: string } | null;
}

/**
 * Collect the Anthropic message ids an agent produced. Only `assistant` rows carry
 * one; `user` and `attachment` rows are the agent's input side and have none.
 * Deduped because the CLI writes one row per content block of the same message.
 */
export function collectSidecarMessageIds(entries: readonly SidecarEntryLike[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    const id = entry.message?.id;
    if (typeof id === 'string' && id) seen.add(id);
  }
  return [...seen];
}

/**
 * Pull the spawn handles out of an `Agent`/`Task` tool_result.
 *
 * Two shapes, both observed live:
 *   - `agent_id: <name>@<teamName>` for an in-process teammate. This is a mailbox
 *     handle, NOT the sidecar id, so it is matched against `meta.name` +
 *     `meta.teamName` rather than used directly.
 *   - `…/tasks/<agentId>.output` for a backgrounded agent, where the path segment
 *     IS the sidecar id.
 */
export function parseAgentHandlesFromToolResult(text: string | null | undefined): {
  teammateHandle?: string;
  outputFileAgentId?: string;
} {
  if (!text) return {};
  const out: { teammateHandle?: string; outputFileAgentId?: string } = {};

  const handle = /agent_id:\s*([^\s"\\]+)/.exec(text);
  if (handle) out.teammateHandle = handle[1];

  // The path is JSON-escaped in the result, so backslashes may be doubled.
  const outputFile = /tasks[\\/]+([A-Za-z0-9_-]+)\.output/.exec(text);
  if (outputFile) out.outputFileAgentId = outputFile[1];

  return out;
}

/** `name@teamName`, the shape a teammate's tool_result reports as `agent_id`. */
function teammateHandleFor(meta: ClaudeCliSubagentMeta | null): string | undefined {
  if (!meta?.name || !meta?.teamName) return undefined;
  return `${meta.name}@${meta.teamName}`;
}

/**
 * Build the join table from sidecars plus the `Agent`/`Task` calls observed so far.
 *
 * Spawn resolution is ordered by confidence: `meta.toolUseId` is authoritative and
 * needs no spawn to have been observed; the teammate handle and the output-file
 * path both require the spawn's tool_result, so they only resolve once it lands.
 */
export function buildClaudeCliSubagentIndex(input: {
  sidecars: readonly ClaudeCliSubagentSidecar[];
  spawns?: readonly ClaudeCliAgentSpawn[];
  /**
   * Message ids the LEAD produced. Anything listed here is never attributed to an
   * agent, which is what keeps a fork from claiming the turn it forked from (see
   * `isForkMeta`). The caller always knows this: the observation layer has already
   * persisted those turns, and a backfill can read the session transcript.
   */
  leadMessageIds?: Iterable<string>;
}): ClaudeCliSubagentIndex {
  const { sidecars, spawns = [] } = input;
  const leadMessageIds = new Set(input.leadMessageIds ?? []);

  const metaByAgentId = new Map<string, ClaudeCliSubagentMeta | null>();
  const agentIdByMessageId = new Map<string, string>();
  for (const sidecar of sidecars) {
    if (!sidecar?.agentId) continue;
    metaByAgentId.set(sidecar.agentId, sidecar.meta ?? null);
    const claimIsFork = isForkMeta(sidecar.meta);
    for (const messageId of sidecar.messageIds ?? []) {
      if (!messageId || leadMessageIds.has(messageId)) continue;
      const incumbent = agentIdByMessageId.get(messageId);
      // A fork's inherited copy must never displace the agent that produced it.
      if (incumbent && claimIsFork && !isForkMeta(metaByAgentId.get(incumbent))) continue;
      agentIdByMessageId.set(messageId, sidecar.agentId);
    }
  }

  // Index the observed spawns by each handle they could be claimed through.
  const spawnByTeammateHandle = new Map<string, string>();
  const spawnByOutputFileAgentId = new Map<string, string>();
  for (const spawn of spawns) {
    if (!spawn?.toolUseId) continue;
    const { teammateHandle, outputFileAgentId } = parseAgentHandlesFromToolResult(spawn.resultText);
    if (teammateHandle && !spawnByTeammateHandle.has(teammateHandle)) {
      spawnByTeammateHandle.set(teammateHandle, spawn.toolUseId);
    }
    if (outputFileAgentId && !spawnByOutputFileAgentId.has(outputFileAgentId)) {
      spawnByOutputFileAgentId.set(outputFileAgentId, spawn.toolUseId);
    }
  }

  const spawnByAgentId = new Map<string, string>();
  for (const [agentId, meta] of metaByAgentId) {
    if (meta?.toolUseId) {
      spawnByAgentId.set(agentId, meta.toolUseId);
      continue;
    }
    const handle = teammateHandleFor(meta);
    const viaHandle = handle ? spawnByTeammateHandle.get(handle) : undefined;
    if (viaHandle) {
      spawnByAgentId.set(agentId, viaHandle);
      continue;
    }
    const viaOutputFile = spawnByOutputFileAgentId.get(agentId);
    if (viaOutputFile) {
      spawnByAgentId.set(agentId, viaOutputFile);
      continue;
    }
    // CLI 2.1.299 reports a teammate's `agent_id` as the sidecar id itself.
    const viaAgentIdHandle = spawnByTeammateHandle.get(agentId);
    if (viaAgentIdHandle) spawnByAgentId.set(agentId, viaAgentIdHandle);
  }

  const agentBySpawn = new Map<string, string>();
  for (const [agentId, toolUseId] of spawnByAgentId) {
    if (!agentBySpawn.has(toolUseId)) agentBySpawn.set(toolUseId, agentId);
  }

  return {
    agentCount: metaByAgentId.size,
    agentIdForMessageId: (messageId) => agentIdByMessageId.get(messageId),
    spawnToolUseIdForAgentId: (agentId) => spawnByAgentId.get(agentId),
    agentIdForSpawnToolUseId: (toolUseId) => agentBySpawn.get(toolUseId),
    parentToolUseIdForMessageId: (messageId) => {
      const agentId = agentIdByMessageId.get(messageId);
      return agentId ? spawnByAgentId.get(agentId) : undefined;
    },
    metaForAgentId: (agentId) => metaByAgentId.get(agentId) ?? undefined,
  };
}

/** An index that knows nothing, for sessions with no sidecar directory yet. */
export function emptyClaudeCliSubagentIndex(): ClaudeCliSubagentIndex {
  return buildClaudeCliSubagentIndex({ sidecars: [] });
}
