/**
 * Incremental reader for the Claude CLI's per-agent sidecar files, feeding
 * `claudeCliSubagentIndex` on the live `claude-code-cli` observation path.
 *
 * Layout (verified live 2026-08-23):
 *   <claude config>/projects/<encoded-cwd>/<sessionId>/subagents/
 *     agent-<agentId>.jsonl        appended as the agent works
 *     agent-<agentId>.meta.json    written once, at spawn
 *
 * ## Why incremental
 *
 * These files get large: a single agent in the reference session reached 13.5MB,
 * and a busy session had 56 of them. Attribution needs one field per assistant
 * row (the Anthropic message id), and the files are append-only, so re-reading
 * them whole on every refresh would be absurd. Instead each file keeps a parsed
 * byte offset and only the newly appended bytes are read and scanned.
 *
 * A trailing partial line is normal: the CLI can be mid-append when we read. The
 * offset only ever advances to the last complete newline, so the partial row is
 * re-read intact on the next refresh rather than being parsed as garbage or lost.
 *
 * ## Why a bounded wait
 *
 * Both the sidecar append and our proxy's response assembly are driven by the
 * same completed HTTP response, so the sidecar row normally exists within
 * milliseconds. It is not ordered, though, so a just-observed turn can arrive
 * before its sidecar row. `waitForParentToolUseId` re-reads a few times over a
 * short budget rather than deciding on the first miss.
 *
 * Filesystem access is injected, so every rule here tests without touching disk.
 */

import * as nodeFs from 'fs/promises';
import * as nodePath from 'path';
import {
  buildClaudeCliSubagentIndex,
  collectSidecarMessageIds,
  emptyClaudeCliSubagentIndex,
  parseSubagentIdFromFileName,
  type ClaudeCliAgentSpawn,
  type ClaudeCliSubagentIndex,
  type ClaudeCliSubagentMeta,
} from './claudeCliSubagentIndex';

/** Filesystem surface the reader needs. Injected so tests stay pure. */
export interface SubagentSidecarFs {
  /** Directory entries, or an empty list when the directory does not exist. */
  listDir(dir: string): Promise<string[]>;
  /** Byte length of a file, or null when it does not exist. */
  fileSize(filePath: string): Promise<number | null>;
  /** Read `[start, end)` as utf-8. */
  readRange(filePath: string, start: number, end: number): Promise<string>;
  /** Read a whole (small) file as utf-8, or null when it does not exist. */
  readTextFile(filePath: string): Promise<string | null>;
  /** Join path segments. */
  join(...parts: string[]): string;
}

interface AgentFileState {
  /** Bytes already scanned; always sits on a newline boundary. */
  parsedBytes: number;
  /** Message ids seen so far, in first-seen order. */
  messageIds: string[];
  /** Meta, once read. Null when the file is absent or unparseable. */
  meta: ClaudeCliSubagentMeta | null;
  /** True once meta has been looked for, so a missing meta is not re-read forever. */
  metaChecked: boolean;
}

export interface ClaudeCliSubagentSidecarReader {
  /**
   * Re-scan appended bytes and rebuild the index. Cheap to call repeatedly: an
   * unchanged file costs one size check.
   */
  refresh(input: {
    subagentsDir: string;
    spawns?: readonly ClaudeCliAgentSpawn[];
    leadMessageIds?: Iterable<string>;
  }): Promise<ClaudeCliSubagentIndex>;
  /** The index as of the last refresh. */
  current(): ClaudeCliSubagentIndex;
  /**
   * Resolve the spawning tool_use id for an observed message, re-reading up to
   * `attempts` times with `delayMs` between tries. Returns undefined when the
   * message is not (yet) any agent's, which the caller must treat as "unknown",
   * never as proof it belongs to the lead.
   */
  waitForParentToolUseId(input: {
    subagentsDir: string;
    messageId: string;
    spawns?: readonly ClaudeCliAgentSpawn[];
    leadMessageIds?: Iterable<string>;
    /** Delays between attempts. Defaults to `SIDECAR_WAIT_BACKOFF_MS`. */
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** Injected clock so the measured lag is testable. */
    now?: () => number;
  }): Promise<{ parentToolUseId?: string; elapsedMs: number; timedOut: boolean }>;
  /** Drop all cached state for this session. */
  clear(): void;
}

/**
 * Backoff schedule for the sidecar wait, in milliseconds between attempts.
 *
 * PROVISIONAL. This is reasoned, not measured, and `claudeCliAttributionStats`
 * exists to replace the reasoning with data: run a real fan-out, read the
 * `[ClaudeCliAttribution]` summary line, and set this above the reported p95.
 *
 * The rationale for this shape. The two mistakes cost very differently. Waiting
 * longer costs latency on a turn that already took seconds, and only in a session
 * that has spawned an agent. Giving up early costs the whole feature for that
 * turn: it falls back to sitting in the lead's transcript, which is the defect
 * being fixed. So the schedule starts far shorter than the old flat 50ms, because
 * the common case is a race of a few milliseconds and should resolve almost
 * immediately, then backs off well past the old 300ms total because the tail is
 * where the cost is asymmetric. Total budget is 1.27s across 7 tries.
 */
export const SIDECAR_WAIT_BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640];

/** Total wait before giving up, for logging alongside the measured percentiles. */
export const SIDECAR_WAIT_BUDGET_MS = SIDECAR_WAIT_BACKOFF_MS.reduce((a, b) => a + b, 0);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Extract the message ids from a chunk of complete jsonl lines. */
function messageIdsFromChunk(chunk: string): string[] {
  const entries: Array<{ type?: string; message?: { id?: string } | null }> = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A malformed row is skipped, not fatal: attribution degrades to "unknown"
      // for that turn rather than taking the whole session's index down.
    }
  }
  return collectSidecarMessageIds(entries);
}

export function createClaudeCliSubagentSidecarReader(
  fs: SubagentSidecarFs,
): ClaudeCliSubagentSidecarReader {
  const byAgentId = new Map<string, AgentFileState>();
  let index: ClaudeCliSubagentIndex = emptyClaudeCliSubagentIndex();

  function stateFor(agentId: string): AgentFileState {
    let state = byAgentId.get(agentId);
    if (!state) {
      state = { parsedBytes: 0, messageIds: [], meta: null, metaChecked: false };
      byAgentId.set(agentId, state);
    }
    return state;
  }

  async function refresh(input: {
    subagentsDir: string;
    spawns?: readonly ClaudeCliAgentSpawn[];
    leadMessageIds?: Iterable<string>;
  }): Promise<ClaudeCliSubagentIndex> {
    const { subagentsDir, spawns = [], leadMessageIds } = input;

    const names = await fs.listDir(subagentsDir);
    const agentIds = new Set<string>();
    for (const name of names) {
      const agentId = parseSubagentIdFromFileName(name);
      if (agentId) agentIds.add(agentId);
    }

    for (const agentId of agentIds) {
      const state = stateFor(agentId);

      if (!state.metaChecked) {
        const raw = await fs.readTextFile(fs.join(subagentsDir, `agent-${agentId}.meta.json`));
        if (raw !== null) {
          state.metaChecked = true;
          try {
            state.meta = JSON.parse(raw) as ClaudeCliSubagentMeta;
          } catch {
            state.meta = null;
          }
        }
        // A missing meta stays unchecked: it is written at spawn, so a miss here
        // means we raced it and it will be there on the next refresh.
      }

      const jsonlPath = fs.join(subagentsDir, `agent-${agentId}.jsonl`);
      const size = await fs.fileSize(jsonlPath);
      if (size === null || size <= state.parsedBytes) continue;

      const chunk = await fs.readRange(jsonlPath, state.parsedBytes, size);
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline < 0) continue; // no complete row yet; re-read next time

      const complete = chunk.slice(0, lastNewline);
      for (const id of messageIdsFromChunk(complete)) {
        if (!state.messageIds.includes(id)) state.messageIds.push(id);
      }
      // Byte length, not character length: the offset indexes bytes on disk.
      state.parsedBytes += Buffer.byteLength(complete, 'utf8') + 1;
    }

    index = buildClaudeCliSubagentIndex({
      sidecars: [...byAgentId.entries()].map(([agentId, state]) => ({
        agentId,
        meta: state.meta,
        messageIds: state.messageIds,
      })),
      spawns,
      leadMessageIds,
    });
    return index;
  }

  return {
    refresh,
    current: () => index,
    clear: () => {
      byAgentId.clear();
      index = emptyClaudeCliSubagentIndex();
    },
    async waitForParentToolUseId(input) {
      const {
        subagentsDir,
        messageId,
        spawns,
        leadMessageIds,
        backoffMs = SIDECAR_WAIT_BACKOFF_MS,
        sleep = defaultSleep,
        now = () => Date.now(),
      } = input;

      const startedAt = now();
      const attempts = Math.max(1, backoffMs.length);

      for (let attempt = 0; attempt < attempts; attempt++) {
        const fresh = await refresh({ subagentsDir, spawns, leadMessageIds });
        const parentToolUseId = fresh.parentToolUseIdForMessageId(messageId);
        if (parentToolUseId) {
          return { parentToolUseId, elapsedMs: now() - startedAt, timedOut: false };
        }
        // Knowing the agent but not its spawn means a teammate whose tool_result
        // has not landed yet. Waiting cannot help, since the spawn arrives on the
        // wire rather than on disk, so this is a give-up rather than a timeout.
        if (fresh.agentIdForMessageId(messageId)) {
          return { elapsedMs: now() - startedAt, timedOut: false };
        }
        if (attempt < attempts - 1) await sleep(backoffMs[attempt]);
      }
      // Budget exhausted. The turn stays unattributed and shows at the top level,
      // exactly as it did before any of this existed.
      return { elapsedMs: now() - startedAt, timedOut: true };
    },
  };
}

/** Real filesystem adapter. A missing directory or file reads as absent, not an error. */
export function nodeSubagentSidecarFs(): SubagentSidecarFs {
  return {
    join: (...parts) => nodePath.join(...parts),
    async listDir(dir) {
      try {
        return await nodeFs.readdir(dir);
      } catch {
        return [];
      }
    },
    async fileSize(filePath) {
      try {
        return (await nodeFs.stat(filePath)).size;
      } catch {
        return null;
      }
    },
    async readRange(filePath, start, end) {
      const handle = await nodeFs.open(filePath, 'r');
      try {
        const length = Math.max(0, end - start);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    },
    async readTextFile(filePath) {
      try {
        return await nodeFs.readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    },
  };
}
