/**
 * The `claude-cli:*` terminal rails are shared by every terminal CLI provider.
 * Where the provider matters (launching, model switch) this picks the right
 * one from the session's stored provider.
 */

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  ensureClaudeCliSession,
  type EnsureClaudeCliSessionInput,
  type EnsureClaudeCliSessionResult,
} from './claudeCliLauncherSingleton';
import { ensureKimiCliSession } from './kimiCliLauncherSingleton';

export async function getSessionProvider(sessionId: string): Promise<string | undefined> {
  try {
    return (await AISessionsRepository.get(sessionId))?.provider;
  } catch (error) {
    console.warn('[TerminalCliRouter] provider lookup failed:', error);
    return undefined;
  }
}

/** Launch (or find running) the genuine CLI this session's provider runs on. */
export async function ensureTerminalCliSession(
  input: EnsureClaudeCliSessionInput,
): Promise<EnsureClaudeCliSessionResult> {
  if ((await getSessionProvider(input.sessionId)) === 'kimi-code-cli') {
    return ensureKimiCliSession(input);
  }
  return ensureClaudeCliSession(input);
}
