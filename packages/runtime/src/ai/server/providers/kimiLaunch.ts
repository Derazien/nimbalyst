/**
 * How to start the `kimi` CLI as a child process.
 *
 * On Windows an npm or pnpm install puts a `kimi.cmd` batch shim on PATH, and
 * Node refuses to execFile or spawn a batch file without a shell (EINVAL).
 * Running it through cmd.exe would put every argument through cmd's quoting
 * rules, so instead the shim is read for the script it launches and that
 * script is run with Node directly, the way the shim itself would: the
 * node.exe beside the shim, else `node` on PATH, else this process's own
 * runtime (Electron needs ELECTRON_RUN_AS_NODE for that).
 */

import fs from 'fs';
import path from 'path';

export interface KimiLaunch {
  /** Executable to spawn. Never a `.cmd`/`.bat`. */
  command: string;
  /** Arguments placed before kimi's own (`acp`, `--version`). */
  prefixArgs: string[];
  /** Variables the launch itself needs, merged into the child env. */
  env: Record<string, string>;
}

function isBatchFile(filePath: string): boolean {
  return /\.(cmd|bat)$/i.test(filePath);
}

/**
 * The node script a Windows npm (cmd-shim) or pnpm shim launches, resolved
 * against the shim's own directory, or undefined when the batch file does
 * not launch a node script.
 */
export function readNodeShimTarget(shim: string, shimPath: string): string | undefined {
  // npm writes "%dp0%\...\main.mjs", pnpm writes "%~dp0\...\main.mjs".
  const match = /"%~?dp0%?\\([^"]+?\.(?:mjs|cjs|js))"/i.exec(shim);
  if (!match) {
    return undefined;
  }
  return path.win32.join(path.win32.dirname(shimPath), match[1]);
}

function findNodeOnPath(pathValue: string | undefined): string | undefined {
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Turn a resolved kimi path into something spawnable. A native binary (or
 * anything that is not a batch file) runs as is; a batch shim becomes Node
 * plus the script it points at; a batch file we cannot read is undefined.
 */
export function resolveKimiLaunch(kimiPath: string, pathValue?: string): KimiLaunch | undefined {
  if (!isBatchFile(kimiPath)) {
    return { command: kimiPath, prefixArgs: [], env: {} };
  }

  let shim: string;
  try {
    shim = fs.readFileSync(kimiPath, 'utf8');
  } catch {
    return undefined;
  }
  const script = readNodeShimTarget(shim, kimiPath);
  if (!script || !fs.existsSync(script)) {
    return undefined;
  }

  const besideShim = path.join(path.dirname(kimiPath), 'node.exe');
  if (fs.existsSync(besideShim)) {
    return { command: besideShim, prefixArgs: [script], env: {} };
  }
  const nodeOnPath = findNodeOnPath(pathValue ?? process.env.PATH);
  if (nodeOnPath) {
    return { command: nodeOnPath, prefixArgs: [script], env: {} };
  }
  return { command: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
