// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  REALTIME_MODEL_CONTEXT_WINDOW_TOKENS,
  getRealtimeContextWindowTokens,
} from '../realtimeModels';

describe('realtime model context windows', () => {
  it('returns the documented window for each selectable model', () => {
    expect(getRealtimeContextWindowTokens('gpt-realtime-2')).toBe(128_000);
    expect(getRealtimeContextWindowTokens('gpt-realtime')).toBe(32_000);
  });

  it('falls back to the smallest known window for unknown or missing models', () => {
    const smallest = Math.min(...Object.values(REALTIME_MODEL_CONTEXT_WINDOW_TOKENS));
    expect(getRealtimeContextWindowTokens('gpt-realtime-mini')).toBe(smallest);
    expect(getRealtimeContextWindowTokens(undefined)).toBe(smallest);
    expect(getRealtimeContextWindowTokens(null)).toBe(smallest);
  });
});
