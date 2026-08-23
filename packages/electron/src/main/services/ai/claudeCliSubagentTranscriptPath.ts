/**
 * Resolve the on-disk transcript of one sub-agent, so the app can open an
 * agent's own conversation from its node in the transcript.
 *
 * The transcript node is keyed by the `Agent`/`Task` tool_use id, while the file
 * is named for the agent id, and those are different values. The sidecar index
 * owns that mapping; this module is the thin lookup around it.
 *
 * Sub-agent transcripts persist independently of the main conversation, so this
 * keeps working for an agent that finished long ago.
 */

import {
  buildClaudeCliSubagentIndex,
  isSubagentToolName,
  parseSubagentIdFromFileName,
} from './claudeCliSubagentIndex';
import type { ClaudeCliAgentSpawn, ClaudeCliSubagentMeta } from './claudeCliSubagentIndex';
import type { SubagentSidecarFs } from './claudeCliSubagentSidecarReader';

/** One persisted `ai_agent_messages` row, narrowed to what spawn recovery reads. */
export interface StoredTranscriptRow {
  content?: string | null;
}

/**
 * Recover the session's `Agent`/`Task` spawns from rows already in the database.
 *
 * The in-memory spawn registry only covers the CURRENT observation session, so
 * after a restart it is empty and an in-process teammate becomes unresolvable:
 * a teammate carries no `meta.toolUseId`, and its only link to its spawn is the
 * `agent_id: <name>@<teamName>` text in the spawn's tool_result. Measured on the
 * reference session that is 36 of 56 agents, which would have left the
 * open-transcript control present and silent on two thirds of the agent nodes.
 *
 * Both shapes the CLI path writes are read here: the assistant row carrying the
 * `Agent` tool_use, and the `nimbalyst_tool_result` row carrying its result.
 */
export function collectSpawnsFromStoredRows(
  rows: readonly StoredTranscriptRow[],
): ClaudeCliAgentSpawn[] {
  const spawnIds = new Set<string>();
  const resultByToolUseId = new Map<string, string>();

  for (const row of rows) {
    if (!row?.content) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue;
    }

    if (parsed?.type === 'nimbalyst_tool_result' && typeof parsed.tool_use_id === 'string') {
      if (typeof parsed.result === 'string') resultByToolUseId.set(parsed.tool_use_id, parsed.result);
      continue;
    }

    const blocks = parsed?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && isSubagentToolName(block.name) && typeof block.id === 'string') {
        spawnIds.add(block.id);
      }
      // A tool_result can also ride inline on a row (the import path writes these).
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        resultByToolUseId.set(block.tool_use_id, text);
      }
    }
  }

  return [...spawnIds].map(toolUseId => ({
    toolUseId,
    resultText: resultByToolUseId.get(toolUseId) ?? null,
  }));
}

/**
 * Whether this session has any sub-agent sidecars at all.
 *
 * Sidecars are a recent CLI feature: of 56 sessions in one real project directory
 * only three had a `subagents/` directory. Without this check the open-transcript
 * control would render on every agent node of every older session and do nothing,
 * which is the dead-affordance shape this codebase keeps being bitten by.
 */
export async function hasSubagentSidecars(
  fs: SubagentSidecarFs,
  subagentsDir: string,
): Promise<boolean> {
  for (const name of await fs.listDir(subagentsDir)) {
    if (parseSubagentIdFromFileName(name)) return true;
  }
  return false;
}

export interface ResolvedSubagentTranscript {
  /** Absolute path to `agent-<agentId>.jsonl`. */
  filePath: string;
  agentId: string;
  /** Agent type for a label, when meta.json carried one. */
  agentType?: string;
  /** The agent's task description, when meta.json carried one. */
  description?: string;
}

/**
 * Find the sidecar transcript for the agent a given spawn produced.
 *
 * Returns null when the directory has no such agent, which is the normal answer
 * for a node from a different provider or a session whose sidecars are gone.
 */
export async function resolveSubagentTranscript(input: {
  fs: SubagentSidecarFs;
  subagentsDir: string;
  /** The `Agent`/`Task` tool_use id, which is what the transcript node carries. */
  spawnToolUseId: string;
  /** Observed spawns, needed to resolve an in-process teammate. */
  spawns?: readonly ClaudeCliAgentSpawn[];
}): Promise<ResolvedSubagentTranscript | null> {
  const { fs, subagentsDir, spawnToolUseId, spawns = [] } = input;
  if (!spawnToolUseId) return null;

  const agentIds = new Set<string>();
  for (const name of await fs.listDir(subagentsDir)) {
    const agentId = parseSubagentIdFromFileName(name);
    if (agentId) agentIds.add(agentId);
  }
  if (agentIds.size === 0) return null;

  // Only meta is read here. Message ids cost a full file scan and play no part
  // in resolving a spawn to its agent.
  const sidecars = [];
  for (const agentId of agentIds) {
    let meta: ClaudeCliSubagentMeta | null = null;
    const raw = await fs.readTextFile(fs.join(subagentsDir, `agent-${agentId}.meta.json`));
    if (raw !== null) {
      try {
        meta = JSON.parse(raw) as ClaudeCliSubagentMeta;
      } catch {
        meta = null;
      }
    }
    sidecars.push({ agentId, meta, messageIds: [] as string[] });
  }

  const index = buildClaudeCliSubagentIndex({ sidecars, spawns });
  const agentId = index.agentIdForSpawnToolUseId(spawnToolUseId);
  if (!agentId) return null;

  const filePath = fs.join(subagentsDir, `agent-${agentId}.jsonl`);
  if ((await fs.fileSize(filePath)) === null) return null;

  const meta = index.metaForAgentId(agentId);
  return {
    filePath,
    agentId,
    ...(meta?.agentType ? { agentType: meta.agentType } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
  };
}
