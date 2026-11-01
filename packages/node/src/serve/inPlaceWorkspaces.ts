/**
 * Same-machine workspaces for the local transport.
 *
 * Over the cloud room the requester's `projectId` is a path on another
 * computer, so the node needs a workspaces file and a git checkout. A node on
 * the SAME machine can run in that directory as it stands, which is the point
 * of a loopback node: the desktop and the node see one tree, and the agent's
 * edits show in the desktop's file tree and diffs with nothing to sync.
 *
 * That is only safe inside roots the operator named. The agent runs with the
 * OS user's permissions, so "any directory the desktop asks for" is not a
 * policy. A project outside every root falls through to the workspaces file,
 * and an unmapped project is refused as before.
 */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { WorkspaceMapping } from './workspaces.js';

export interface InPlaceDeps {
  realPath?: (target: string) => string;
  isDirectory?: (target: string) => boolean;
}

function defaultIsDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The canonical directory for `projectId` when it is an existing directory
 * under one of `roots`, after resolving symlinks on both sides. Undefined
 * otherwise; never throws for a path that simply does not qualify.
 */
export function resolveInPlaceDirectory(
  projectId: string,
  roots: readonly string[],
  deps: InPlaceDeps = {},
): string | undefined {
  if (!projectId || !path.isAbsolute(projectId) || roots.length === 0) return undefined;
  const realPath = deps.realPath ?? realpathSync;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  if (!isDirectory(projectId)) return undefined;
  let target: string;
  try {
    target = realPath(projectId);
  } catch {
    return undefined;
  }
  for (const root of roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = realPath(root);
    } catch {
      continue;
    }
    const a = process.platform === 'win32' ? target.toLowerCase() : target;
    const b = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
    if (isWithin(a, b)) return target;
  }
  return undefined;
}

/** A mapping that runs the agent in the requester's own directory. */
export function inPlaceMapping(
  projectId: string,
  roots: readonly string[],
  deps: InPlaceDeps = {},
): WorkspaceMapping | undefined {
  const checkoutDir = resolveInPlaceDirectory(projectId, roots, deps);
  return checkoutDir ? { projectId, repoUrl: '', branch: '', checkoutDir, inPlace: true } : undefined;
}

/** Re-confine an in-place mapping on every use; the tree may have moved. */
export function confineInPlace(mapping: WorkspaceMapping, roots: readonly string[], deps: InPlaceDeps = {}): string {
  const checkoutDir = resolveInPlaceDirectory(mapping.projectId, roots, deps);
  if (!checkoutDir) {
    throw new Error(`[nimbalyst-node] ${mapping.projectId} is no longer a directory under the configured in-place roots`);
  }
  return checkoutDir;
}
