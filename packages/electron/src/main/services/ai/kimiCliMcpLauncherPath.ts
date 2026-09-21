import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { findNodeOnPath } from '@nimbalyst/runtime/ai/server/providers/kimiLaunch';
import type { KimiSpawnableCommand } from '@nimbalyst/runtime/ai/server/providers/kimiMcpCommand';
import { getPackageRoot } from '../../utils/appPaths';
import { KIMI_MCP_LAUNCHER_FILENAME } from './kimiCliMcpConfig';

/**
 * How kimi should run the bundled MCP launcher (`kimiCliMcpLauncher.cjs`), or
 * undefined when the script is missing. Same layout as the Claude CLI
 * permission hook: beside the app's resources when packaged (electron-builder
 * `extraResources`), in `<packageRoot>/resources/` in development.
 *
 * Plain node when there is one on PATH, because kimi keeps one launcher alive
 * per MCP server and node is far lighter than Nimbalyst-as-node.
 */
export function resolveKimiCliMcpLauncher(pathValue: string | undefined): KimiSpawnableCommand | undefined {
  const candidates = app.isPackaged
    ? (process.resourcesPath
      ? [join(process.resourcesPath, KIMI_MCP_LAUNCHER_FILENAME), join(process.resourcesPath, 'resources', KIMI_MCP_LAUNCHER_FILENAME)]
      : [])
    : [join(getPackageRoot(), 'resources', KIMI_MCP_LAUNCHER_FILENAME)];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) return undefined;

  const node = findNodeOnPath(pathValue);
  return node
    ? { command: node, args: [script] }
    : { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
