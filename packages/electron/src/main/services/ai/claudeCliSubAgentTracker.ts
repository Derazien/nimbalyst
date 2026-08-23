/**
 * Per-session registry of the sub-agents a `claude-code-cli` session spawned.
 *
 * ## What this used to be, and why it changed
 *
 * This module previously answered "is SOME sub-agent running right now", and the
 * observation layer used that answer to decide whether to HIDE a turn. Two things
 * were wrong with it.
 *
 * First it only matched the tool name `Task`, and the CLI renamed that tool to
 * `Agent` in 2.1.63. Both transcript parsers were updated to accept either name;
 * this module was not. So on any modern CLI the window never opened, every
 * sub-agent turn was persisted visible, and a session running a dozen agents
 * interleaved all of their output into the lead's transcript.
 *
 * Second, and the reason the obvious one-word fix is wrong: a single in-flight
 * flag cannot serve concurrent agents. With `run_in_background` the lead keeps
 * working while agents run, so the window stays open across the LEAD's own turns
 * and hiding on it would hide the lead's output instead. It also cannot say WHICH
 * of eight to twelve running agents produced a turn, which is what the tree needs.
 *
 * Attribution now comes from `claudeCliSubagentIndex`, which joins observed
 * message ids to the CLI's per-agent sidecars. What remains here is the half that
 * genuinely lives on the wire and nowhere else: the spawning tool_use ids and
 * their tool_result text, which is how an in-process teammate is matched to its
 * spawn. Visibility is no longer decided here at all.
 */

import { isSubagentToolName, type ClaudeCliAgentSpawn } from './claudeCliSubagentIndex';

interface AssistantToolBlock {
  type: string;
  name?: string;
  id?: string;
}

interface AssistantTurnLike {
  content: AssistantToolBlock[];
}

/** Spawning tool_use id to its result text (null until the result is observed). */
const spawnsBySession = new Map<string, Map<string, string | null>>();

function getSpawns(sessionId: string): Map<string, string | null> {
  let spawns = spawnsBySession.get(sessionId);
  if (!spawns) {
    spawns = new Map<string, string | null>();
    spawnsBySession.set(sessionId, spawns);
  }
  return spawns;
}

/**
 * Record any `Agent`/`Task` tool calls in a just-observed assistant turn.
 *
 * Accepts both spellings: `Agent` since CLI 2.1.63, `Task` for older runs.
 */
export function noteAssistantSubagentSpawns(sessionId: string, msg: AssistantTurnLike): void {
  if (!sessionId || !Array.isArray(msg?.content)) return;
  const spawns = getSpawns(sessionId);
  for (const block of msg.content) {
    if (block?.type !== 'tool_use') continue;
    if (!isSubagentToolName(block.name)) continue;
    if (typeof block.id !== 'string' || !block.id) continue;
    if (!spawns.has(block.id)) spawns.set(block.id, null);
  }
}

/**
 * Attach result text to spawns as their `tool_result` shows up in a request body.
 *
 * The text is load-bearing, not diagnostic: an in-process teammate carries no
 * `toolUseId` in its sidecar meta, so `agent_id: <name>@<teamName>` in this text
 * is the only thing tying it to the call that spawned it.
 */
export function noteSubagentSpawnResults(
  sessionId: string,
  results: ReadonlyArray<{ toolUseId: string; content?: string | null }>,
): void {
  const spawns = spawnsBySession.get(sessionId);
  if (!spawns) return;
  for (const result of results) {
    if (spawns.has(result.toolUseId)) spawns.set(result.toolUseId, result.content ?? null);
  }
}

/** Every spawn observed so far this session, for the attribution index. */
export function getSubagentSpawns(sessionId: string): ClaudeCliAgentSpawn[] {
  const spawns = spawnsBySession.get(sessionId);
  if (!spawns) return [];
  return [...spawns.entries()].map(([toolUseId, resultText]) => ({ toolUseId, resultText }));
}

/**
 * Whether this session has ever spawned a sub-agent.
 *
 * Used only to skip attribution work entirely for the overwhelming majority of
 * sessions that never spawn one. It is a performance gate, never a visibility or
 * attribution decision.
 */
export function hasAnySubagentSpawn(sessionId: string): boolean {
  return (spawnsBySession.get(sessionId)?.size ?? 0) > 0;
}

/** Drop the session's registry (call when its observation session ends). */
export function clearSubAgentTracking(sessionId: string): void {
  spawnsBySession.delete(sessionId);
}
