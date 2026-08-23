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

import { buildClaudeCliSubagentIndex, parseSubagentIdFromFileName } from './claudeCliSubagentIndex';
import type { ClaudeCliAgentSpawn, ClaudeCliSubagentMeta } from './claudeCliSubagentIndex';
import type { SubagentSidecarFs } from './claudeCliSubagentSidecarReader';

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
