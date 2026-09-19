/**
 * The live Kimi Code CLI session runtimes, by Nimbalyst session id. Its own
 * module so the shared CLI submit path can ask "is this a kimi terminal?"
 * without importing the launcher (which imports the queue flush, which
 * imports the submit path).
 */

import type { KimiCliSessionRuntime } from './kimiCliSessionRuntime';

export const kimiCliRuntimes = new Map<string, KimiCliSessionRuntime>();

/** Is this Nimbalyst session a running Kimi Code CLI terminal? */
export function isKimiCliTerminal(sessionId: string): boolean {
  return kimiCliRuntimes.has(sessionId);
}
