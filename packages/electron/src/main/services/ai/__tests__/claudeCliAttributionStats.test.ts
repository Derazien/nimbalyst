// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearAttributionStats,
  formatAttributionSummary,
  recordAttributionSample,
  summarizeAttribution,
  takeAttributionSummary,
} from '../claudeCliAttributionStats';

const SID = 'session-1';

describe('summarizeAttribution', () => {
  it('reports percentiles over resolved samples only', () => {
    // A timeout has no meaningful lag: it is the budget, not an observation, so
    // including it would flatter the percentile that the budget is tuned against.
    const samples = [
      { elapsedMs: 5, timedOut: false },
      { elapsedMs: 10, timedOut: false },
      { elapsedMs: 200, timedOut: false },
      { elapsedMs: 1270, timedOut: true },
    ];

    expect(summarizeAttribution(samples)).toEqual({
      total: 4, resolved: 3, timedOut: 1, p50Ms: 10, p95Ms: 200, maxMs: 200,
    });
  });

  it('handles a run where nothing resolved', () => {
    expect(summarizeAttribution([{ elapsedMs: 1270, timedOut: true }])).toEqual({
      total: 1, resolved: 0, timedOut: 1, p50Ms: 0, p95Ms: 0, maxMs: 0,
    });
  });

  it('handles no samples at all', () => {
    expect(summarizeAttribution([]).total).toBe(0);
  });
});

describe('formatAttributionSummary', () => {
  it('names the budget beside the measurement, so the comparison is obvious', () => {
    const line = formatAttributionSummary(
      'abcdef12-3456', { total: 10, resolved: 10, timedOut: 0, p50Ms: 8, p95Ms: 42, maxMs: 60 }, 1270,
    );

    expect(line).toContain('n=10 resolved=10 timedOut=0');
    expect(line).toContain('p95=42ms');
    expect(line).toContain('budget=1270ms');
    expect(line).not.toContain('TIMEOUTS');
  });

  it('says what a timeout meant and what to do about it', () => {
    const line = formatAttributionSummary(
      'abcdef12', { total: 10, resolved: 7, timedOut: 3, p50Ms: 900, p95Ms: 1200, maxMs: 1250 }, 1270,
    );

    expect(line).toContain('TIMEOUTS');
    expect(line).toContain('raise the budget above p95');
  });
});

describe('recordAttributionSample', () => {
  beforeEach(() => clearAttributionStats(SID));

  it('emits a summary only once every N samples', () => {
    expect(recordAttributionSample(SID, { elapsedMs: 1, timedOut: false }, 3)).toBeNull();
    expect(recordAttributionSample(SID, { elapsedMs: 2, timedOut: false }, 3)).toBeNull();

    const summary = recordAttributionSample(SID, { elapsedMs: 3, timedOut: false }, 3);
    expect(summary?.total).toBe(3);

    // The counter resets, so the next summary is another N away.
    expect(recordAttributionSample(SID, { elapsedMs: 4, timedOut: false }, 3)).toBeNull();
  });

  it('summarises everything so far, not just the last window', () => {
    for (let i = 0; i < 4; i++) recordAttributionSample(SID, { elapsedMs: 1, timedOut: false }, 2);

    expect(takeAttributionSummary(SID)?.total).toBe(4);
  });

  it('reports nothing for a session that never attributed anything', () => {
    expect(takeAttributionSummary('never-ran')).toBeNull();
  });

  it('clears per session', () => {
    recordAttributionSample(SID, { elapsedMs: 1, timedOut: false }, 1);
    clearAttributionStats(SID);

    expect(takeAttributionSummary(SID)).toBeNull();
  });
});
