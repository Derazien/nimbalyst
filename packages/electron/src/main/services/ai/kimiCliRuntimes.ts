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

const typing = new Map<string, Promise<unknown>>();

/**
 * Run `task` once nothing else is typing into this session's terminal. A
 * prompt, the model picker and the effort picker are all keystrokes into the
 * same kimi, and a prompt pasted while a picker is open lands inside it.
 */
export function typeIntoKimiCliTerminal<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const result = (typing.get(sessionId) ?? Promise.resolve()).then(task, task);
  const settled = result.catch(() => undefined);
  typing.set(sessionId, settled);
  void settled.then(() => {
    if (typing.get(sessionId) === settled) typing.delete(sessionId);
  });
  return result;
}
