/**
 * Production-credibility overhead bar (locked in issue 02).
 * Compares recorder=enabled vs recorder=disabled structural no-op.
 */

export interface CellMetrics {
  p50Ms: number;
  p99Ms: number;
  throughputRps: number;
  samples: number;
}

export interface OverheadThresholds {
  maxP50Increase: number;
  maxP99Increase: number;
  minThroughputRatio: number;
  minSamples: number;
}

/** First-release CI gate (B). */
export const B_BAR: OverheadThresholds = {
  maxP50Increase: 0.2,
  maxP99Increase: 0.4,
  minThroughputRatio: 0.8,
  minSamples: 10_000,
};

/** Tighter release requirement (A) — reported, not blocking, until promotion. */
export const A_BAR: OverheadThresholds = {
  maxP50Increase: 0.1,
  maxP99Increase: 0.2,
  minThroughputRatio: 0.9,
  minSamples: 10_000,
};

export interface OverheadCellResult {
  ok: boolean;
  failures: string[];
  p50Increase: number;
  p99Increase: number;
  throughputRatio: number;
  baseline: CellMetrics;
  enabled: CellMetrics;
  bar: string;
}

function ratioIncrease(enabled: number, baseline: number): number {
  return baseline <= 0
    ? Number.POSITIVE_INFINITY
    : (enabled - baseline) / baseline;
}

function collectOverheadFailures(
  baseline: CellMetrics,
  enabled: CellMetrics,
  thresholds: OverheadThresholds,
  p50Increase: number,
  p99Increase: number,
  throughputRatio: number,
): string[] {
  const failures: string[] = [];

  if (
    baseline.samples < thresholds.minSamples ||
    enabled.samples < thresholds.minSamples
  ) {
    failures.push("insufficient sample");
  }
  if (
    baseline.p50Ms <= 0 ||
    baseline.p99Ms <= 0 ||
    baseline.throughputRps <= 0
  ) {
    failures.push("invalid baseline metrics");
  }
  if (p50Increase > thresholds.maxP50Increase) {
    failures.push(
      `p50 increase ${(p50Increase * 100).toFixed(1)}% > ${(thresholds.maxP50Increase * 100).toFixed(0)}%`,
    );
  }
  if (p99Increase > thresholds.maxP99Increase) {
    failures.push(
      `p99 increase ${(p99Increase * 100).toFixed(1)}% > ${(thresholds.maxP99Increase * 100).toFixed(0)}%`,
    );
  }
  if (throughputRatio < thresholds.minThroughputRatio) {
    failures.push(
      `throughput ratio ${throughputRatio.toFixed(3)} < ${thresholds.minThroughputRatio.toFixed(2)}`,
    );
  }
  return failures;
}

export function evaluateOverheadCell(
  baseline: CellMetrics,
  enabled: CellMetrics,
  thresholds: OverheadThresholds,
  barLabel: string = thresholds === A_BAR ? "A" : "B",
): OverheadCellResult {
  const p50Increase = ratioIncrease(enabled.p50Ms, baseline.p50Ms);
  const p99Increase = ratioIncrease(enabled.p99Ms, baseline.p99Ms);
  const throughputRatio =
    baseline.throughputRps <= 0
      ? 0
      : enabled.throughputRps / baseline.throughputRps;
  const failures = collectOverheadFailures(
    baseline,
    enabled,
    thresholds,
    p50Increase,
    p99Increase,
    throughputRatio,
  );

  return {
    ok: failures.length === 0,
    failures,
    p50Increase,
    p99Increase,
    throughputRatio,
    baseline,
    enabled,
    bar: barLabel,
  };
}

export interface VarianceResult {
  ok: boolean;
  passes: number;
  trials: number;
}

/** Locked variance control: at least 2 of 3 trial passes (or all passes when fewer trials). */
export function evaluateVariance(
  trialPasses: boolean[],
  minPasses = 2,
): VarianceResult {
  const passes = trialPasses.filter(Boolean).length;
  const needed = Math.min(minPasses, trialPasses.length);
  return {
    ok: passes >= needed,
    passes,
    trials: trialPasses.length,
  };
}

/** Nearest-rank percentile for a sorted ascending sample array. */
export function percentileSorted(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedMs.length) - 1;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, rank));
  const value = sortedMs[idx];
  return value === undefined ? 0 : value;
}

export function summarizeLatencies(latenciesMs: number[]): {
  p50Ms: number;
  p99Ms: number;
  samples: number;
} {
  const sorted = latenciesMs.slice().sort((a, b) => a - b);
  return {
    p50Ms: percentileSorted(sorted, 50),
    p99Ms: percentileSorted(sorted, 99),
    samples: sorted.length,
  };
}
