/**
 * Kimi Code CLI provider — the genuine `kimi` CLI running interactively on the
 * user's Kimi **membership** (CLI OAuth device flow, no API key anywhere).
 * This is the interactive/CLI half of the Kimi Code provider family;
 * `kimi-code` is the ACP transport (`kimi acp`) that Nimbalyst drives
 * programmatically.
 *
 * Two provider IDs, one vendor agent — mirrors the `claude-code` /
 * `claude-code-cli` precedent. The split exists for transport parity with
 * Claude (both memberships are the subscription path on their side, so there
 * is no billing axis to lock here); it still keeps a started session pinned
 * to its transport via `shouldBlockStartedSessionProviderSwitch()` — a
 * session can never flip between the ACP-driven and terminal-driven paths
 * once it has messages.
 *
 * Rollout is phased (same shape as the claude-code-cli rollout):
 *
 * - Phase 0 (this file, initial): provider identity + model catalog wiring so
 *   the rest of the app can route, validate, and construct this provider. The
 *   actual CLI driving (`sendMessage`) lands in Phase 1.
 * - Phase 1+: spawn the interactive `kimi` CLI in the terminal strip;
 *   observation backends reconstruct the transcript.
 *
 * HARD SAFETY INVARIANT: this provider never reads API keys from the
 * environment — auth is `kimi login` and nothing else. See CLAUDE.md.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import {
  AIModel,
  AIProviderType,
  DocumentContext,
  ProviderConfig,
  StreamChunk,
} from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { DEFAULT_MODELS } from '../../modelConstants';
import type { ProviderSessionData } from './ProviderSessionManager';

export class KimiCodeCliProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['kimi-code-cli'];

  getProviderName(): AIProviderType {
    return 'kimi-code-cli';
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  // eslint-disable-next-line require-yield
  async *sendMessage(
    _message: string,
    _documentContext?: DocumentContext,
    _sessionId?: string,
    _messages?: unknown[],
    _workspacePath?: string,
    _attachments?: unknown[]
  ): AsyncIterableIterator<StreamChunk> {
    // Phase 1 wires this to the genuine `kimi` CLI in the terminal strip.
    throw new Error(
      'Kimi Code CLI (interactive terminal) provider not yet implemented (Phase 1).'
    );
  }

  getProviderSessionData(sessionId: string): ProviderSessionData | null {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return { providerSessionId };
  }

  /**
   * Model catalog — shares the Kimi alias set with `kimi-code` but under the
   * `kimi-code-cli:` namespace so the two providers stay distinct in the
   * registry and the per-session transport lock holds. Mirrors the static
   * alias catalog in `KimiCodeProvider` (the CLI's ACP model picker values).
   */
  static async getModels(): Promise<AIModel[]> {
    const aliases: Array<{ alias: string; name: string; contextWindow: number }> = [
      { alias: 'k3', name: 'Kimi K3', contextWindow: 1048576 },
      { alias: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262144 },
      { alias: 'kimi-for-coding', name: 'Kimi for Coding (K2.8 Preview)', contextWindow: 262144 },
      { alias: 'kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed (K2.7)', contextWindow: 262144 },
    ];

    return aliases.map((entry) => ({
      id: ModelIdentifier.create('kimi-code-cli', entry.alias).combined,
      name: `Kimi Code CLI · ${entry.name}`,
      provider: 'kimi-code-cli' as const,
      contextWindow: entry.contextWindow,
    }));
  }

  static getDefaultModel(): string {
    return KimiCodeCliProvider.DEFAULT_MODEL;
  }
}
