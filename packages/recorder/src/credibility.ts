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

/** Minimal cell shape needed to compare frozen vs new credibility reports. */
export interface CredibilityReportTrialBar {
  ok: boolean;
  p50Increase: number;
  p99Increase: number;
  throughputRatio: number;
}

export interface CredibilityReportCell {
  scenario: string;
  concurrency: number;
  trials: Array<{
    b: CredibilityReportTrialBar;
    a: CredibilityReportTrialBar;
  }>;
  bVariance: VarianceResult;
  aVariance: VarianceResult;
}

export interface CredibilityBReport {
  type: "credibility_b_report";
  profile: string;
  /** Present on harness-emitted reports; compared when both sides have it. */
  warmupMs?: number;
  measureMs?: number;
  trialsPerCell?: number;
  cells: CredibilityReportCell[];
}

export interface BarMetricSummary {
  p50Increase: number;
  p99Increase: number;
  throughputRatio: number;
}

/** Candidate − baseline for each overhead metric (not a ratio-of-ratios). */
export type BarMetricDeltas = BarMetricSummary;

export interface ProtocolPassFail {
  baselineOk: boolean;
  candidateOk: boolean;
  baselinePasses: number;
  baselineTrials: number;
  candidatePasses: number;
  candidateTrials: number;
}

export interface CellCompareResult {
  scenario: string;
  concurrency: number;
  baseline: { b: BarMetricSummary; a: BarMetricSummary };
  candidate: { b: BarMetricSummary; a: BarMetricSummary };
  deltas: { b: BarMetricDeltas; a: BarMetricDeltas };
  protocol: { b: ProtocolPassFail; a: ProtocolPassFail };
}

export interface CredibilityCompareReport {
  type: "credibility_b_compare";
  baselineProfile: string;
  candidateProfile: string;
  cells: CellCompareResult[];
  /** True when cell sets and protocol metadata match; not B/A variance success. */
  matched: boolean;
  failures: string[];
}

function cellKey(scenario: string, concurrency: number): string {
  return `${scenario}@${concurrency}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function summarizeBar(trials: CredibilityReportTrialBar[]): BarMetricSummary {
  return {
    p50Increase: median(trials.map((t) => t.p50Increase)),
    p99Increase: median(trials.map((t) => t.p99Increase)),
    throughputRatio: median(trials.map((t) => t.throughputRatio)),
  };
}

function barDeltas(
  baseline: BarMetricSummary,
  candidate: BarMetricSummary,
): BarMetricDeltas {
  return {
    p50Increase: candidate.p50Increase - baseline.p50Increase,
    p99Increase: candidate.p99Increase - baseline.p99Increase,
    throughputRatio: candidate.throughputRatio - baseline.throughputRatio,
  };
}

function protocolPassFail(
  baseline: VarianceResult,
  candidate: VarianceResult,
): ProtocolPassFail {
  return {
    baselineOk: baseline.ok,
    candidateOk: candidate.ok,
    baselinePasses: baseline.passes,
    baselineTrials: baseline.trials,
    candidatePasses: candidate.passes,
    candidateTrials: candidate.trials,
  };
}

function assertSameProtocolMeta(
  baseline: CredibilityBReport,
  candidate: CredibilityBReport,
  failures: string[],
): void {
  if (baseline.profile !== candidate.profile) {
    failures.push(
      `profile mismatch: baseline=${baseline.profile} candidate=${candidate.profile}`,
    );
  }
  for (const field of ["warmupMs", "measureMs", "trialsPerCell"] as const) {
    const left = baseline[field];
    const right = candidate[field];
    if (left === undefined || right === undefined) continue;
    if (left !== right) {
      failures.push(`${field} mismatch: baseline=${left} candidate=${right}`);
    }
  }
}

/**
 * Compare a candidate `credibility_b_report` to a frozen headroom baseline.
 * Per-cell B/A overhead metrics use the median across trials; protocol pass/fail
 * mirrors each report's variance gates (same B/A protocol, not re-thresholded).
 */
export function compareCredibilityReports(
  baselineInput: unknown,
  candidateInput: unknown,
): CredibilityCompareReport {
  const failures: string[] = [];
  const baseline = readCredibilityReport(baselineInput, "baseline", failures);
  const candidate = readCredibilityReport(
    candidateInput,
    "candidate",
    failures,
  );

  if (!baseline || !candidate) {
    return {
      type: "credibility_b_compare",
      baselineProfile: baseline?.profile ?? "unknown",
      candidateProfile: candidate?.profile ?? "unknown",
      cells: [],
      matched: false,
      failures,
    };
  }

  assertSameProtocolMeta(baseline, candidate, failures);

  const candidateByKey = new Map(
    candidate.cells.map((c) => [cellKey(c.scenario, c.concurrency), c]),
  );
  const cells: CellCompareResult[] = [];

  for (const baseCell of baseline.cells) {
    const key = cellKey(baseCell.scenario, baseCell.concurrency);
    const candCell = candidateByKey.get(key);
    if (!candCell) {
      failures.push(`missing candidate cell ${key}`);
      continue;
    }
    candidateByKey.delete(key);

    const baselineB = summarizeBar(baseCell.trials.map((t) => t.b));
    const baselineA = summarizeBar(baseCell.trials.map((t) => t.a));
    const candidateB = summarizeBar(candCell.trials.map((t) => t.b));
    const candidateA = summarizeBar(candCell.trials.map((t) => t.a));

    cells.push({
      scenario: baseCell.scenario,
      concurrency: baseCell.concurrency,
      baseline: { b: baselineB, a: baselineA },
      candidate: { b: candidateB, a: candidateA },
      deltas: {
        b: barDeltas(baselineB, candidateB),
        a: barDeltas(baselineA, candidateA),
      },
      protocol: {
        b: protocolPassFail(baseCell.bVariance, candCell.bVariance),
        a: protocolPassFail(baseCell.aVariance, candCell.aVariance),
      },
    });
  }

  for (const extra of candidateByKey.keys()) {
    failures.push(`unexpected candidate cell ${extra}`);
  }

  return {
    type: "credibility_b_compare",
    baselineProfile: baseline.profile,
    candidateProfile: candidate.profile,
    cells,
    matched: failures.length === 0,
    failures,
  };
}

function readCredibilityReport(
  value: unknown,
  label: string,
  failures: string[],
): CredibilityBReport | null {
  if (value === null || typeof value !== "object") {
    failures.push(`${label} is not an object`);
    return null;
  }
  const report = value as Partial<CredibilityBReport>;
  if (report.type !== "credibility_b_report") {
    failures.push(`${label} is not a credibility_b_report`);
    return null;
  }
  if (typeof report.profile !== "string" || !Array.isArray(report.cells)) {
    failures.push(`${label} is missing profile or cells`);
    return null;
  }
  return report as CredibilityBReport;
}
