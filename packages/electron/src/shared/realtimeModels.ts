/**
 * OpenAI Realtime (speech-to-speech) model facts shared by the main-process
 * voice client and the renderer's voice UI.
 *
 * Context windows come from the OpenAI model pages (checked 2026-08-21):
 *   - gpt-realtime-2: 128,000-token context window, 32,000 max output
 *   - gpt-realtime:   32,000-token context window, 4,096 max output
 */

/** Selectable OpenAI Realtime speech-to-speech models. */
export type RealtimeModel = 'gpt-realtime-2' | 'gpt-realtime';

export const REALTIME_MODEL_CONTEXT_WINDOW_TOKENS: Record<RealtimeModel, number> = {
  'gpt-realtime-2': 128_000,
  'gpt-realtime': 32_000,
};

/**
 * Context window for a Realtime model. An unknown or missing model resolves to
 * the smallest known window so a meter built on it over-warns rather than
 * under-warns.
 */
export function getRealtimeContextWindowTokens(model: string | null | undefined): number {
  if (model && model in REALTIME_MODEL_CONTEXT_WINDOW_TOKENS) {
    return REALTIME_MODEL_CONTEXT_WINDOW_TOKENS[model as RealtimeModel];
  }
  return Math.min(...Object.values(REALTIME_MODEL_CONTEXT_WINDOW_TOKENS));
}
