/**
 * Live-mode discovery file for the `nim` companion CLI.
 *
 * The MCP bearer token is generated per-launch and held in memory only
 * (mcpAuth.ts) — it "dies with the process" and is not otherwise discoverable.
 * To let an out-of-process CLI talk to a *running* Nimbalyst over the loopback
 * MCP-HTTP server, we write a small, user-only-readable descriptor at startup
 * and delete it on quit:
 *
 *   <userData>/mcp-endpoint.json  (mode 0600)
 *   { pid, port, token, startedAt, schemaVersion?, workspaces: [{ path, name }] }
 *
 * Security: 0600, loopback-only server, pid-liveness checked by the reader, and
 * the token is already the app's CORS/loopback mitigation. The CLI confirms the
 * pid is alive before trusting a descriptor (a crash can leave a stale file).
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface EndpointWorkspace {
  path: string;
  name?: string;
}

export interface WriteDescriptorParams {
  port: number;
  token: string;
  schemaVersion?: number;
  workspaces?: EndpointWorkspace[];
}

function descriptorPath(): string {
  return path.join(app.getPath('userData'), 'mcp-endpoint.json');
}

/**
 * True when this process may own the descriptor: it holds the single-instance lock, or the app runs in
 * multi-instance mode (dev with NIMBALYST_USER_DATA_DIR, Playwright). A second instance launched while one runs
 * (it stays alive a moment to relay an open-file) must not write over the running instance's descriptor.
 */
function ownsDescriptor(): boolean {
  if (process.env.NIMBALYST_USER_DATA_DIR || process.env.PLAYWRIGHT) return true;
  try {
    return app.hasSingleInstanceLock();
  } catch {
    return true;
  }
}

/** Write (or rewrite) the endpoint descriptor. Best-effort: never throws. */
export function writeMcpEndpointDescriptor(params: WriteDescriptorParams): void {
  if (!ownsDescriptor()) {
    logger.mcp.info('Not writing the MCP endpoint descriptor: another Nimbalyst instance holds the lock');
    return;
  }
  try {
    const payload = {
      pid: process.pid,
      port: params.port,
      token: params.token,
      startedAt: new Date().toISOString(),
      schemaVersion: params.schemaVersion,
      workspaces: params.workspaces ?? [],
    };
    const file = descriptorPath();
    // Write with 0600 so only the user can read the token.
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    // writeFileSync's mode only applies on create; enforce on existing files too.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* non-fatal */
    }
    logger.mcp.info('Wrote MCP endpoint descriptor for nim CLI', file);
  } catch (err) {
    logger.mcp.error('Failed to write MCP endpoint descriptor:', err);
  }
}

/**
 * Remove the descriptor on quit, but only when it is this process's own (its pid). A quitting second instance
 * must not delete the running instance's descriptor (2026-10-28: that left out-of-process tools with no endpoint
 * until the next restart). Best-effort: never throws.
 */
export function removeMcpEndpointDescriptor(): void {
  try {
    const file = descriptorPath();
    let owner: unknown;
    try {
      owner = JSON.parse(fs.readFileSync(file, 'utf8'))?.pid;
    } catch {
      return; // no file, or not readable: nothing of ours to remove
    }
    if (owner !== process.pid) return;
    fs.rmSync(file, { force: true });
  } catch {
    /* non-fatal */
  }
}
