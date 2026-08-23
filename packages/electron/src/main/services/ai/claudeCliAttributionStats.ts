/**
 * Measure how long sub-agent attribution actually waits, so the wait budget can
 * stop being a guess.
 *
 * `claudeCliSubagentSidecarReader` waits a bounded time for an agent's sidecar
 * row to appear before giving up and leaving the turn unattributed. That budget
 * was reasoned about, not measured: both the CLI's append and our own response
 * assembly are driven by the same completed HTTP response, so the lag "should"
 * be milliseconds. Nobody has watched it under a twelve-agent fan-out on a busy
 * disk, and if the real p95 exceeds the budget the symptom is silent: turns fall
 * back to the top level and it looks like the feature half-works.
 *
 * So record every attribution: how long it took, and whether the budget ran out.
 * A summary line goes to the log periodically and at session teardown, which is
 * something a person can actually read after a real fan-out.
 *
 * To re-tune: run a big fan-out, read the summary line, and set the budget above
 * the reported p95 with headroom. Raising the budget only costs latency on turns
 * that would otherwise have been unattributed anyway.
 */

export interface AttributionSample {
  /** Milliseconds from starting the lookup to resolving or giving up. */
  elapsedMs: number;
  /** True when the wait budget ran out without an answer. */
  timedOut: boolean;
}

export interface AttributionSummary {
  total: number;
  resolved: number;
  timedOut: number;
  /** Percentiles over RESOLVED samples only; a timeout has no meaningful lag. */
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Emit a summary roughly this often, so a real fan-out produces one. */
export const ATTRIBUTION_SUMMARY_EVERY = 25;

const bySession = new Map<string, AttributionSample[]>();
const sinceLastSummary = new Map<string, number>();

/** Nearest-rank percentile over a sorted array. Empty input reports 0. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarizeAttribution(samples: readonly AttributionSample[]): AttributionSummary {
  const resolvedLags = samples.filter(s => !s.timedOut).map(s => s.elapsedMs).sort((a, b) => a - b);
  return {
    total: samples.length,
    resolved: resolvedLags.length,
    timedOut: samples.filter(s => s.timedOut).length,
    p50Ms: percentile(resolvedLags, 0.5),
    p95Ms: percentile(resolvedLags, 0.95),
    maxMs: resolvedLags.length ? resolvedLags[resolvedLags.length - 1] : 0,
  };
}

/** One line a person can read, naming the budget so the comparison is obvious. */
export function formatAttributionSummary(
  sessionId: string,
  summary: AttributionSummary,
  budgetMs: number,
): string {
  return (
    `[ClaudeCliAttribution] ${sessionId.slice(0, 8)} `
    + `n=${summary.total} resolved=${summary.resolved} timedOut=${summary.timedOut} `
    + `p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms budget=${budgetMs}ms`
    + (summary.timedOut > 0
      ? ' | TIMEOUTS: those turns fell back to the top level; raise the budget above p95'
      : '')
  );
}

/**
 * Record one attribution and return a summary when it is time to log one.
 * Returns null the rest of the time.
 */
export function recordAttributionSample(
  sessionId: string,
  sample: AttributionSample,
  everyN: number = ATTRIBUTION_SUMMARY_EVERY,
): AttributionSummary | null {
  let samples = bySession.get(sessionId);
  if (!samples) {
    samples = [];
    bySession.set(sessionId, samples);
  }
  samples.push(sample);

  const pending = (sinceLastSummary.get(sessionId) ?? 0) + 1;
  if (pending < Math.max(1, everyN)) {
    sinceLastSummary.set(sessionId, pending);
    return null;
  }
  sinceLastSummary.set(sessionId, 0);
  return summarizeAttribution(samples);
}

/**
 * The session's summary so far, or null when it never attributed anything.
 * Peeks rather than consumes: every caller wants the running total, so a big
 * fan-out reports cumulatively rather than resetting mid-flight.
 */
export function peekAttributionSummary(sessionId: string): AttributionSummary | null {
  const samples = bySession.get(sessionId);
  if (!samples || samples.length === 0) return null;
  return summarizeAttribution(samples);
}

export function clearAttributionStats(sessionId: string): void {
  bySession.delete(sessionId);
  sinceLastSummary.delete(sessionId);
}
