/**
 * An MCP server command kimi can actually start on Windows.
 *
 * kimi spawns stdio MCP servers without a shell, and Node refuses a batch file
 * that way (EINVAL). Nimbalyst's MCP config turns `npx` into `npx.cmd` on
 * Windows, which Claude Code and Codex start through a shell, so in kimi every
 * npx-based server the user configured failed to start. As with kimi's own
 * shim (kimiLaunch.ts), the batch file is read for the node script it launches
 * and that script is run with Node directly, which keeps every argument out of
 * cmd.exe's quoting rules. cmd.exe is the last resort, for a batch file that
 * launches something else.
 */

import fs from 'fs';
import path from 'path';
import { readNodeShimTarget } from './kimiLaunch';

export interface KimiSpawnableCommand {
  command: string;
  args: string[];
  /** Variables the command itself needs, on top of the server's own. */
  env?: Record<string, string>;
}

export interface KimiSpawnableCommandDeps {
  platform?: NodeJS.Platform;
  pathValue?: string;
  comSpec?: string;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
}

const BATCH = /\.(cmd|bat)$/i;

/**
 * npm's own launchers (`npx.cmd`, `npm.cmd`) name their script in a variable:
 * `SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"` then
 * `"%NODE_EXE%" "%NPX_CLI_JS%" %*`.
 */
function readNpmLauncherTarget(batch: string, batchPath: string): string | undefined {
  const run = /"%NODE_EXE%"\s+"%(\w+)%"\s+%\*/i.exec(batch);
  if (!run) return undefined;
  const assigned = new RegExp(`SET\\s+"${run[1]}=%~dp0\\\\([^"]+?\\.(?:mjs|cjs|js))"`, 'i').exec(batch);
  return assigned ? path.win32.join(path.win32.dirname(batchPath), assigned[1]) : undefined;
}

export function toKimiSpawnableCommand(
  command: string,
  args: string[],
  deps: KimiSpawnableCommandDeps = {},
): KimiSpawnableCommand {
  const unchanged = { command, args };
  if ((deps.platform ?? process.platform) !== 'win32') return unchanged;

  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const pathDirs = (deps.pathValue ?? process.env.PATH ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const onPath = (name: string) =>
    pathDirs.map((dir) => path.win32.join(dir, name)).find((candidate) => exists(candidate));

  let batchPath: string | undefined;
  if (BATCH.test(command)) {
    batchPath = path.win32.isAbsolute(command) ? command : onPath(command);
  } else if (!path.win32.extname(command) && !/[\\/]/.test(command)) {
    // Plain spawn finds `name.exe` by itself but never `name.cmd`.
    if (!onPath(`${command}.exe`) && !onPath(`${command}.com`)) {
      batchPath = onPath(`${command}.cmd`) ?? onPath(`${command}.bat`);
    }
  }
  if (!batchPath) return unchanged;

  let batch = '';
  try {
    batch = readFile(batchPath);
  } catch {
    // Unreadable: still not something plain spawn can start.
  }
  const script = readNodeShimTarget(batch, batchPath) ?? readNpmLauncherTarget(batch, batchPath);
  if (script && exists(script)) {
    const besideBatch = path.win32.join(path.win32.dirname(batchPath), 'node.exe');
    const node = exists(besideBatch) ? besideBatch : onPath('node.exe');
    if (node) return { command: node, args: [script, ...args] };
    return { command: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  // Simple arguments survive cmd.exe; one holding & | < > ^ % and no space does not.
  return { command: deps.comSpec ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', batchPath, ...args] };
}
