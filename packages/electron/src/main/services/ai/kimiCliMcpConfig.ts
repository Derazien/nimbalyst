/**
 * MCP servers for a Kimi Code CLI session: Nimbalyst's own servers plus the
 * ones the user set up in app and project settings, the same set the ACP
 * `kimi-code` provider hands to `session/new`.
 *
 * The genuine `kimi` terminal app (2.0.2) has no flag for this. It reads
 * servers from three files and nothing else: `~/.kimi-code/mcp.json`,
 * `<project root>/.mcp.json` and `<cwd>/.kimi-code/mcp.json`. The two project
 * files sit inside the user's repository and only load once kimi trusts the
 * folder, so the home file is the one that works, and it is shared by every
 * kimi on the machine while Nimbalyst's servers differ per session (the
 * session id is in their address, the token changes every app start).
 *
 * So the home file only ever names a server and points it at
 * `kimiCliMcpLauncher.cjs`. The real servers go in a private file per session,
 * and kimi is started with NIMBALYST_KIMI_MCP_CONFIG naming it. kimi passes
 * its environment to the servers it starts, so each launcher finds its own
 * session's server. Two sessions cannot read each other's, and nothing with an
 * address or a secret in it reaches the shared file.
 *
 * The home file is the user's. Only entries that run the launcher are ever
 * added, changed or removed; a server they defined under the same name wins;
 * a file that does not parse is left alone; and Nimbalyst's names come back
 * out when the last Kimi Code CLI session that needs them ends.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { toKimiSpawnableCommand, type KimiSpawnableCommand } from '@nimbalyst/runtime/ai/server/providers/kimiMcpCommand';
import { deepEqual, writeFileAtomic } from '../HeadlessAgentMcpConfigService';

export const KIMI_MCP_CONFIG_ENV = 'NIMBALYST_KIMI_MCP_CONFIG';
export const KIMI_MCP_LAUNCHER_FILENAME = 'kimiCliMcpLauncher.cjs';

type McpEntry = Record<string, unknown>;
interface McpFile {
  mcpServers?: Record<string, McpEntry>;
  [key: string]: unknown;
}

export interface KimiCliMcpConfigDeps {
  /** How to run the launcher script: the executable, then the script path. */
  launcher: () => KimiSpawnableCommand | undefined;
  kimiHome?: string;
  tempDir?: string;
  toSpawnable?: (command: string, args: string[]) => KimiSpawnableCommand;
}

export interface PreparedKimiCliMcp {
  /** Merge into kimi's environment. */
  env: Record<string, string>;
  /** Servers the user already defined in kimi under the same name; theirs were kept. */
  skipped: string[];
}

function isLauncherEntry(entry: McpEntry | undefined): boolean {
  const args = entry?.args;
  return Array.isArray(args) && args.some((arg) => typeof arg === 'string' && path.win32.basename(arg) === KIMI_MCP_LAUNCHER_FILENAME);
}

export class KimiCliMcpConfigService {
  /** Server names each live session needs, so one ending does not strand another. */
  private readonly live = new Map<string, string[]>();
  /** The home file is one read-merge-write shared by every session. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: KimiCliMcpConfigDeps) {}

  /** Null when the session gets no servers; never throws, a launch matters more. */
  async prepare(sessionId: string, servers: Record<string, unknown>): Promise<PreparedKimiCliMcp | null> {
    try {
      const launcher = this.deps.launcher();
      if (!launcher) {
        console.warn('[KimiCliMcp] the MCP launcher script was not found; kimi starts without Nimbalyst MCP servers');
        return null;
      }
      const toSpawnable = this.deps.toSpawnable ?? ((command, args) => toKimiSpawnableCommand(command, args));
      const sessionServers: Record<string, McpEntry> = {};
      const homeEntries: Record<string, McpEntry> = {};
      for (const [name, raw] of Object.entries(servers)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const server = raw as McpEntry;
        if (typeof server.command === 'string' && server.command) {
          // Neither kimi nor the launcher uses a shell, which a .cmd needs.
          const spawnable = toSpawnable(server.command, Array.isArray(server.args) ? (server.args as string[]) : []);
          const env = { ...((server.env as Record<string, string>) ?? {}), ...(spawnable.env ?? {}) };
          sessionServers[name] = { ...server, command: spawnable.command, args: spawnable.args, ...(Object.keys(env).length ? { env } : {}) };
        } else {
          sessionServers[name] = server;
        }
        homeEntries[name] = {
          command: launcher.command,
          args: [...launcher.args, name],
          ...(launcher.env ? { env: launcher.env } : {}),
          // kimi gives a tool call 60 seconds; the questions Nimbalyst asks a person wait longer.
          ...(typeof server.timeout === 'number' ? { toolTimeoutMs: server.timeout } : {}),
        };
      }

      const dir = this.deps.tempDir ?? path.join(os.tmpdir(), 'nimbalyst-kimi-cli');
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.mcp.json`);
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: sessionServers }, null, 2), { encoding: 'utf8', mode: 0o600 });

      this.live.set(sessionId, Object.keys(homeEntries));
      const skipped = await this.enqueue(() => this.syncHome(homeEntries));
      if (skipped === null) {
        this.live.delete(sessionId);
        return null;
      }
      return { env: { [KIMI_MCP_CONFIG_ENV]: configPath }, skipped };
    } catch (error) {
      console.warn('[KimiCliMcp] could not set up MCP servers for kimi; it starts without them:', error);
      this.live.delete(sessionId);
      return null;
    }
  }

  /** The session's kimi is gone: take back the names nothing else here needs. */
  async release(sessionId: string): Promise<void> {
    const names = this.live.get(sessionId);
    if (!names) return;
    this.live.delete(sessionId);
    try {
      await this.enqueue(() => this.syncHome({}, names));
    } catch (error) {
      console.warn('[KimiCliMcp] could not tidy kimi\'s MCP file:', error);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Add `entries`, and take `released` names back out unless a live session
   * here still needs them. Nothing else is removed: a launcher entry this
   * process did not use may belong to another Nimbalyst running beside it.
   * Returns the names left to the user's own entries, or null when the file
   * must not be touched.
   */
  private async syncHome(entries: Record<string, McpEntry>, released: string[] = []): Promise<string[] | null> {
    const home = this.deps.kimiHome ?? process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
    const file = path.join(home, 'mcp.json');
    let existing: McpFile | null = null;
    let mode: number | null = null;
    try {
      existing = JSON.parse(await fs.readFile(file, 'utf8')) as McpFile;
      mode = (await fs.stat(file)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[KimiCliMcp] ${file} could not be read as JSON, so it is left as it is`);
        return null;
      }
    }
    if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) return null;

    const needed = new Set([...this.live.values()].flat());
    const previous = existing?.mcpServers ?? {};
    const next: Record<string, McpEntry> = {};
    const skipped: string[] = [];
    for (const [name, entry] of Object.entries(previous)) {
      const takeBack = released.includes(name) && !needed.has(name) && isLauncherEntry(entry);
      if (!takeBack) next[name] = entry;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (name in previous && !isLauncherEntry(previous[name])) skipped.push(name);
      else next[name] = entry;
    }

    const merged: McpFile = { ...(existing ?? {}), mcpServers: next };
    if (existing === null && Object.keys(next).length === 0) return skipped;
    if (existing !== null && deepEqual(existing, merged)) return skipped;
    await fs.mkdir(home, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, mode);
    return skipped;
  }
}
