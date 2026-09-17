import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveClaudeConfigDir } from "@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir";
import {
  encodeWorkspaceDir,
  type ClaudeCodeEntry,
} from "../ClaudeCodeSessionScanner";
import {
  entryToMessage,
  importedClaudeCodeModel,
  inlinePersistedOutputsUsing,
  PERSISTED_OUTPUT_PATTERN,
} from "./claudeCodeImportCodec";
import {
  type JsonlEntry,
  BoundedDiscovery,
  AcceptedHeaderCache,
  DEFAULT_READ_BYTES,
  positiveLimit,
  readJsonl,
  validWorkspace,
  validateSourcePath,
} from "./jsonlReader";
import type {
  ExternalCursor,
  ExternalDiscoverOptions,
  ExternalReadOptions,
  ExternalDiscoveryPage,
  ExternalReadResult,
  ExternalSessionRef,
  ExternalSessionSource,
  ExternalSourceOptions,
} from "./types";
import {
  buildClaudeCliSubagentIndex,
  isSubagentToolName,
  type ClaudeCliSubagentMeta,
} from "../ai/claudeCliSubagentIndex";

/** A sidecar's meta file is a few hundred bytes; anything larger is not one. */
const MAX_SUBAGENT_META_BYTES = 64 * 1024;

/** `Agent`/`Task` calls seen so far in one parent log, and how far it was read. */
interface SpawnScan {
  cursor: ExternalCursor | null;
  /** tool_use id -> flattened tool_result text, null until the result lands. */
  spawns: Map<string, string | null>;
}

type ClaudeTitleState = Partial<
  Record<"custom" | "ai" | "fallback", { value: string; offset: number }>
> & { through: number };

export class ClaudeCodeSource implements ExternalSessionSource {
  readonly providerId = "claude-code" as const;
  private readonly root: string;
  private readonly discovery = new BoundedDiscovery();
  private readonly headers = new AcceptedHeaderCache();
  private readonly titles = new Map<string, ClaudeTitleState>();
  /** Sidecar file -> the tool_use id that spawned it. A resolved link never changes. */
  private readonly spawnIds = new Map<string, string>();
  /** Parent log -> its spawns, read incrementally so a live follow never rescans it. */
  private readonly spawnScans = new Map<string, SpawnScan>();
  /** Sidecar file -> its meta, null when it has none. Read once per sidecar. */
  private readonly subagentMetas = new Map<string, ClaudeCliSubagentMeta | null>();

  private updateTitle(
    file: string,
    records: JsonlEntry[],
    reset: boolean,
    start: number,
    end: number
  ): string | undefined {
    const state: ClaudeTitleState = reset
      ? { through: 0 }
      : this.titles.get(file) ?? { through: 0 };
    // An EOF read cannot fill an unseen historical gap. Only contiguous reads
    // from the beginning establish which title is authoritative at a saved cursor.
    if ((reset ? 0 : start) <= state.through)
      state.through = Math.max(state.through, end);
    for (const record of records) {
      const entry = record.value;
      for (const [kind, value] of [
        ["custom", entry.customTitle],
        ["ai", entry.aiTitle],
      ] as const) {
        if (
          typeof value === "string" &&
          value.length <= 4096 &&
          value.trim() &&
          (!state[kind] || record.byteOffset >= state[kind]!.offset)
        )
          state[kind] = { value: value.trim(), offset: record.byteOffset };
      }
      if (!state.fallback || record.byteOffset < state.fallback.offset) {
        const fallback = importedTitle([entry]);
        if (fallback && !entry.customTitle && !entry.aiTitle)
          state.fallback = { value: fallback, offset: record.byteOffset };
      }
    }
    this.titles.delete(file);
    this.titles.set(file, state);
    if (this.titles.size > 512)
      this.titles.delete(this.titles.keys().next().value!);
    return state.custom?.value ?? state.ai?.value ?? state.fallback?.value;
  }
  private titleKind(
    file: string,
    title: string | undefined
  ): ExternalSessionRef["titleKind"] {
    if (!title) return undefined;
    const state = this.titles.get(file);
    if (state?.custom?.value === title) return "explicit";
    if (state?.ai?.value === title) return "generated";
    return "fallback";
  }

  constructor(private readonly options: ExternalSourceOptions = {}) {
    this.root = path.resolve(
      options.rootDir ??
        process.env.NIMBALYST_CLAUDE_PROJECTS_DIR ??
        path.join(resolveClaudeConfigDir(), "projects")
    );
  }

  watchRoots(workspaces: string[]): string[] {
    return [
      ...new Set(
        workspaces
          .filter(path.isAbsolute)
          .map((cwd) => path.join(this.root, encodeWorkspaceDir(cwd)))
      ),
    ];
  }

  async identify(
    filePath: string,
    workspacePaths: string[]
  ): Promise<ExternalSessionRef | null> {
    for (const workspace of workspacePaths.filter(path.isAbsolute)) {
      try {
        const ref = await this.inspect(filePath, workspace);
        if (ref) return ref;
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    return null;
  }

  async discover(
    workspacePath: string,
    options: ExternalDiscoverOptions = {}
  ): Promise<ExternalSessionRef[]> {
    if (!path.isAbsolute(workspacePath)) return [];
    return (await this.scanPage(workspacePath, false, options.skipUnchanged))
      .sessions;
  }

  discoverPage(workspacePath?: string): Promise<ExternalDiscoveryPage> {
    return this.scanPage(workspacePath, true);
  }

  private async scanPage(
    workspacePath: string | undefined,
    manual: boolean,
    skipUnchanged?: ExternalDiscoverOptions["skipUnchanged"]
  ): Promise<ExternalDiscoveryPage> {
    if (workspacePath !== undefined && !path.isAbsolute(workspacePath))
      return { sessions: [], hasMore: false };
    const root = workspacePath
      ? path.join(this.root, encodeWorkspaceDir(workspacePath))
      : this.root;
    const page = await this.discovery.page(
      `${manual ? "manual" : "live"}:${workspacePath ?? "*"}`,
      root,
      workspacePath ? 2 : 3,
      positiveLimit(this.options.maxDiscoveryEntries, 100),
      (relative) => {
        const parts = relative.split(path.sep);
        if (!workspacePath) parts.shift();
        return (
          parts.length <= 1 || (parts.length === 2 && parts[1] === "subagents")
        );
      }
    );
    const sessions: ExternalSessionRef[] = [];
    for (const file of page.paths) {
      try {
        if (skipUnchanged) {
          // Titles live in the log itself, so an unchanged stamp means nothing new.
          const stat = await fs.stat(file);
          if (
            skipUnchanged(file, {
              inode: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            })
          )
            continue;
        }
        const ref = await this.inspect(file, workspacePath, {
          includeFinalLine: manual,
        });
        if (ref) sessions.push(ref);
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    return { sessions, hasMore: page.hasMore };
  }

  private async inspect(
    filePath: string,
    workspacePath?: string,
    readOptions: ExternalReadOptions = {}
  ): Promise<ExternalSessionRef | null> {
    if (!path.isAbsolute(filePath)) return null;
    const parts = path.relative(this.root, filePath).split(path.sep);
    const workspaceDir = parts.shift();
    if (
      !workspaceDir ||
      (workspacePath !== undefined &&
        workspaceDir !== encodeWorkspaceDir(workspacePath))
    )
      return null;
    const workspaceRoot = path.join(this.root, workspaceDir);
    let externalId: string;
    let parentToolUseId: string | undefined;
    if (
      parts.length === 1 &&
      parts[0].endsWith(".jsonl") &&
      !parts[0].startsWith("agent-")
    ) {
      externalId = path.basename(filePath, ".jsonl");
    } else if (
      parts.length === 3 &&
      parts[1] === "subagents" &&
      /^agent-.+\.jsonl$/.test(parts[2])
    ) {
      externalId = parts[0];
      parentToolUseId = parts[2].slice(6, -6);
    } else return null;
    if (!externalId || externalId === "." || externalId === "..") return null;
    // A sidecar may omit cwd entirely. Its physical parent log is the only
    // authority for inheritance; the encoded directory is never decoded.
    const parent = parentToolUseId
      ? await this.inspect(
          path.join(workspaceRoot, `${externalId}.jsonl`),
          workspacePath,
          readOptions
        )
      : null;
    if (parentToolUseId && !parent) return null;
    const cached = await this.headers.get(this.root, filePath, workspacePath);
    if (
      cached &&
      (parentToolUseId || this.titles.has(filePath)) &&
      (!parent || validWorkspace(cached.workspacePath, parent.workspacePath))
    ) {
      const delta = await readJsonl(filePath, this.headers.cursor(filePath)!, {
        ...this.options,
        ...readOptions,
        maxReadBytes: Math.min(
          64 * 1024,
          positiveLimit(this.options.maxReadBytes, DEFAULT_READ_BYTES)
        ),
      });
      if (
        delta.entries.some(
          ({ value: e }) =>
            !recordedCwd(e.cwd) ||
            (e.sessionId !== undefined && e.sessionId !== externalId) ||
            (parentToolUseId
              ? e.agentId !== undefined && e.agentId !== parentToolUseId
              : e.isSidechain === true)
        )
      )
        return null;
      cached.title = parentToolUseId
        ? undefined
        : this.updateTitle(
            filePath,
            delta.entries,
            delta.reset,
            this.headers.cursor(filePath)!.byteOffset,
            delta.cursor.byteOffset
          );
      cached.titleKind = this.titleKind(filePath, cached.title);
      this.headers.set(cached, delta.cursor);
      return cached;
    }
    try {
      await validateSourcePath(this.root, filePath);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw error;
      return null;
    }
    const head = await readJsonl(filePath, null, {
      ...this.options,
      ...readOptions,
      maxReadBytes: Math.min(
        64 * 1024,
        positiveLimit(this.options.maxReadBytes, DEFAULT_READ_BYTES)
      ),
    });
    const entries = head.entries.map((e) => e.value);
    // Claude Code stamps each entry with the agent shell's current directory,
    // which follows every `cd`. Only the launch cwd (the first one recorded, and
    // the one the project directory encodes) scopes the session; a sidecar
    // belongs to its verified parent wherever the parent's shell had moved.
    const cwd = parent
      ? parent.workspacePath
      : entries.find((e) => e.cwd !== undefined)?.cwd;
    if (
      typeof cwd !== "string" ||
      !path.isAbsolute(cwd) ||
      workspaceDir !== encodeWorkspaceDir(cwd)
    )
      return null;
    if (workspacePath !== undefined && !validWorkspace(cwd, workspacePath))
      return null;
    if (entries.some((e) => !recordedCwd(e.cwd))) return null;
    if (
      entries.some(
        (e) => e.sessionId !== undefined && e.sessionId !== externalId
      )
    )
      return null;
    if (
      parentToolUseId &&
      entries.some(
        (e) => e.agentId !== undefined && e.agentId !== parentToolUseId
      )
    )
      return null;
    if (!parentToolUseId && entries.some((e) => e.isSidechain === true))
      return null;
    const stat = await fs.stat(filePath);
    const title = parentToolUseId
      ? undefined
      : this.updateTitle(
          filePath,
          head.entries,
          true,
          0,
          head.cursor.byteOffset
        );
    const ref: ExternalSessionRef = {
      providerId: this.providerId,
      externalId,
      workspacePath: path.resolve(cwd),
      filePath,
      updatedAt: stat.mtimeMs,
      createdAt: validTime(entries[0]?.timestamp),
      title,
      titleKind: this.titleKind(filePath, title),
      model: importedClaudeCodeModel(entries as ClaudeCodeEntry[]),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    };
    this.headers.set(ref, head.cursor);
    return ref;
  }

  async readSince(
    ref: ExternalSessionRef,
    cursor: ExternalCursor | null,
    readOptions: ExternalReadOptions = {}
  ): Promise<ExternalReadResult> {
    const inspected =
      ref.providerId === this.providerId
        ? await this.inspect(ref.filePath, ref.workspacePath, readOptions)
        : null;
    if (
      !inspected ||
      inspected.externalId !== ref.externalId ||
      inspected.parentToolUseId !== ref.parentToolUseId
    )
      throw new Error("External Claude session reference failed validation");
    const page = await readJsonl(ref.filePath, cursor, {
      ...this.options,
      ...readOptions,
    });
    const messages: ExternalReadResult["messages"] = [];
    let title: string | undefined = ref.parentToolUseId
      ? undefined
      : inspected.title;
    const toolResults = path.join(
      this.root,
      encodeWorkspaceDir(ref.workspacePath),
      ref.externalId,
      "tool-results"
    );
    // A byte budget spans every persisted-output block in this batch.
    let outputBudget = positiveLimit(
      this.options.maxReadBytes,
      DEFAULT_READ_BYTES
    );
    // `ref.parentToolUseId` is the sidecar's identity, the agent id from its file
    // name. It is not a tool_use id and matches none, so it must never be what
    // the parser nests under. Resolve the call that really spawned this agent.
    const spawnToolUseId = ref.parentToolUseId
      ? await this.resolveSpawnToolUseId(ref, readOptions)
      : undefined;
    for (const record of page.entries) {
      const entry = record.value as ClaudeCodeEntry;
      if (!recordedCwd(entry.cwd))
        throw new Error("External Claude session cwd is malformed");
      if (entry.sessionId !== undefined && entry.sessionId !== ref.externalId)
        throw new Error("External Claude session identity changed");
      if (
        ref.parentToolUseId &&
        entry.agentId !== undefined &&
        entry.agentId !== ref.parentToolUseId
      )
        throw new Error("External Claude sidecar identity changed");

      await inlinePersistedOutputsUsing(entry, async (text) => {
        const externalPath = text.match(PERSISTED_OUTPUT_PATTERN)?.[1]?.trim();
        if (
          !externalPath ||
          !path.isAbsolute(externalPath) ||
          outputBudget <= 0
        )
          return null;
        try {
          await validateSourcePath(this.root, externalPath);
          await validateSourcePath(toolResults, externalPath);
          const handle = await fs.open(externalPath, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > outputBudget) return null;
            const bytes = Buffer.alloc(stat.size);
            const read = await handle.read(bytes, 0, bytes.length, 0);
            outputBudget -= read.bytesRead;
            return bytes.subarray(0, read.bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      });
      // Stable fallback time matters when a producer omits timestamps and we replay.
      const message = entryToMessage({
        ...entry,
        timestamp: entry.timestamp ?? new Date(0).toISOString(),
      });
      if (!message) continue;
      // An agent whose spawn cannot be found is imported unlinked: an
      // unattributable turn is shown at the top level, never swallowed.
      if (spawnToolUseId) {
        message.content = JSON.stringify({
          ...JSON.parse(message.content),
          parent_tool_use_id: spawnToolUseId,
        });
      }
      const sourceEntryId = createHash("sha256")
        .update(
          `${this.providerId}\x1f${ref.externalId}\x1f${path.relative(
            this.root,
            ref.filePath
          )}\x1f${record.entryId}`
        )
        .digest("hex");
      messages.push({ ...message, sourceEntryId });
    }
    if (!ref.parentToolUseId)
      title =
        this.updateTitle(
          ref.filePath,
          page.entries,
          page.reset,
          cursor?.byteOffset ?? 0,
          page.cursor.byteOffset
        ) ?? (page.reset ? undefined : title);
    if (
      !page.reset &&
      cursor &&
      (this.titles.get(ref.filePath)?.through ?? 0) < cursor.byteOffset
    )
      title = undefined;
    return {
      messages,
      cursor: page.cursor,
      reset: page.reset,
      hasMore: page.hasMore,
      title,
      titleKind: this.titleKind(ref.filePath, title),
      model: importedClaudeCodeModel(
        page.entries.map((e) => e.value as ClaudeCodeEntry)
      ),
    };
  }

  /**
   * The `Agent`/`Task` tool_use id that spawned a sidecar, by confidence: the
   * meta file names it outright; an in-process teammate or a backgrounded agent
   * is matched through the spawn's tool_result in the parent log. Undefined when
   * nothing visible spawned it, which a later read may still resolve.
   */
  private async resolveSpawnToolUseId(
    ref: ExternalSessionRef,
    readOptions: ExternalReadOptions
  ): Promise<string | undefined> {
    const agentId = ref.parentToolUseId;
    if (!agentId) return undefined;
    const known = this.spawnIds.get(ref.filePath);
    if (known) return known;

    // The CLI writes the meta file once, at spawn. Reading it again on every
    // append would re-validate a path the follow loop has already accepted, so
    // a miss is remembered too. Only the parent scan is worth retrying.
    let meta = this.subagentMetas.get(ref.filePath);
    if (meta === undefined) {
      meta = await this.readSubagentMeta(ref.filePath);
      this.subagentMetas.set(ref.filePath, meta);
    }
    const spawns = meta?.toolUseId
      ? []
      : await this.scanSpawns(
          path.join(
            this.root,
            encodeWorkspaceDir(ref.workspacePath),
            `${ref.externalId}.jsonl`
          ),
          readOptions
        );
    const resolved = buildClaudeCliSubagentIndex({
      sidecars: [{ agentId, meta, messageIds: [] }],
      spawns,
    }).spawnToolUseIdForAgentId(agentId);
    if (resolved) this.spawnIds.set(ref.filePath, resolved);
    return resolved;
  }

  /** `agent-<id>.meta.json` beside the sidecar. Optional, so every failure is a miss. */
  private async readSubagentMeta(
    sidecarPath: string
  ): Promise<ClaudeCliSubagentMeta | null> {
    const metaPath = sidecarPath.replace(/\.jsonl$/, ".meta.json");
    try {
      await validateSourcePath(this.root, metaPath);
      const handle = await fs.open(metaPath, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_SUBAGENT_META_BYTES) return null;
        const bytes = Buffer.alloc(stat.size);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        const parsed = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Every `Agent`/`Task` call in a parent log with its result text. The scan
   * resumes from where the last one stopped, so following a session live reads
   * each byte of the parent once instead of rescanning it for every sidecar page.
   */
  private async scanSpawns(
    parentPath: string,
    readOptions: ExternalReadOptions
  ): Promise<Array<{ toolUseId: string; resultText: string | null }>> {
    let scan = this.spawnScans.get(parentPath);
    if (!scan) {
      scan = { cursor: null, spawns: new Map() };
      this.spawnScans.set(parentPath, scan);
    }
    try {
      for (;;) {
        const page = await readJsonl(parentPath, scan.cursor, {
          ...this.options,
          ...readOptions,
        });
        // A replaced or truncated parent invalidates everything read from it.
        if (page.reset) scan.spawns.clear();
        for (const { value } of page.entries) {
          const content = value?.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block?.type === "tool_use" && block.id && isSubagentToolName(block.name)) {
              if (!scan.spawns.has(block.id)) scan.spawns.set(block.id, null);
            } else if (block?.type === "tool_result" && scan.spawns.has(block.tool_use_id)) {
              scan.spawns.set(
                block.tool_use_id,
                typeof block.content === "string" ? block.content : JSON.stringify(block.content)
              );
            }
          }
        }
        const advanced = page.cursor.byteOffset > (scan.cursor?.byteOffset ?? -1);
        scan.cursor = page.cursor;
        if (!advanced || page.entries.length === 0) break;
      }
    } catch {
      // A parent that cannot be read resolves nothing; the sidecar imports unlinked.
    }
    return [...scan.spawns].map(([toolUseId, resultText]) => ({ toolUseId, resultText }));
  }

  dispose(): Promise<void> {
    this.headers.clear();
    this.titles.clear();
    this.spawnIds.clear();
    this.spawnScans.clear();
    this.subagentMetas.clear();
    return this.discovery.dispose();
  }
}

/** A per-entry cwd may be absent or anywhere absolute; it never rescopes the session. */
function recordedCwd(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && path.isAbsolute(value))
  );
}

function validTime(value: unknown): number | undefined {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

function importedTitle(entries: Record<string, any>[]): string | undefined {
  const aiTitle = entries
    .slice()
    .reverse()
    .find((e) => typeof e.aiTitle === "string" && e.aiTitle.trim())?.aiTitle;
  if (aiTitle) return aiTitle;
  for (const entry of entries) {
    const message = entryToMessage(entry as ClaudeCodeEntry);
    if (message?.direction === "input") {
      const prompt = JSON.parse(message.content).prompt;
      if (typeof prompt === "string" && prompt.trim())
        return prompt.slice(0, 50) + "...";
    }
  }
  return undefined;
}
