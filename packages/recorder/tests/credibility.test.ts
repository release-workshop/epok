import { describe, expect, it } from "vitest";
import {
  B_BAR,
  A_BAR,
  compareCredibilityReports,
  evaluateOverheadCell,
  evaluateVariance,
  type CellMetrics,
  type CredibilityBReport,
  type OverheadThresholds,
} from "../src/credibility.js";

function trial(metrics: {
  p50Increase: number;
  p99Increase: number;
  throughputRatio: number;
  bOk?: boolean;
  aOk?: boolean;
}) {
  const bOk = metrics.bOk ?? true;
  const aOk = metrics.aOk ?? true;
  return {
    trial: 1,
    b: {
      ok: bOk,
      p50Increase: metrics.p50Increase,
      p99Increase: metrics.p99Increase,
      throughputRatio: metrics.throughputRatio,
    },
    a: {
      ok: aOk,
      p50Increase: metrics.p50Increase,
      p99Increase: metrics.p99Increase,
      throughputRatio: metrics.throughputRatio,
    },
  };
}

function cell(
  scenario: string,
  concurrency: number,
  metrics: {
    p50Increase: number;
    p99Increase: number;
    throughputRatio: number;
    bOk?: boolean;
    aOk?: boolean;
  },
) {
  const bOk = metrics.bOk ?? true;
  const aOk = metrics.aOk ?? true;
  const one = trial(metrics);
  return {
    scenario,
    concurrency,
    trials: [one, { ...one, trial: 2 }, { ...one, trial: 3 }],
    bVariance: { ok: bOk, passes: bOk ? 3 : 0, trials: 3 },
    aVariance: { ok: aOk, passes: aOk ? 3 : 0, trials: 3 },
  };
}

function report(
  cells: ReturnType<typeof cell>[],
  profile = "premerge",
): CredibilityBReport {
  return {
    type: "credibility_b_report",
    profile,
    cells,
  };
}

describe("credibility overhead evaluation", () => {
  const baseline: CellMetrics = {
    p50Ms: 10,
    p99Ms: 20,
    throughputRps: 1000,
    samples: 12_000,
  };

  it("passes B when overhead stays within locked thresholds", () => {
    const enabled: CellMetrics = {
      p50Ms: 12, // +20%
      p99Ms: 28, // +40%
      throughputRps: 800, // 0.80
      samples: 12_000,
    };
    const result = evaluateOverheadCell(baseline, enabled, B_BAR);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.p50Increase).toBeCloseTo(0.2);
    expect(result.p99Increase).toBeCloseTo(0.4);
    expect(result.throughputRatio).toBeCloseTo(0.8);
  });

  it("fails B on p50, p99, throughput, or insufficient sample", () => {
    expect(
      evaluateOverheadCell(
        baseline,
        { ...baseline, p50Ms: 12.1, samples: 12_000 },
        B_BAR,
      ).ok,
    ).toBe(false);

    expect(
      evaluateOverheadCell(
        baseline,
        { ...baseline, p99Ms: 28.1, samples: 12_000 },
        B_BAR,
      ).ok,
    ).toBe(false);

    expect(
      evaluateOverheadCell(
        baseline,
        { ...baseline, throughputRps: 799, samples: 12_000 },
        B_BAR,
      ).ok,
    ).toBe(false);

    const insufficient = evaluateOverheadCell(
      baseline,
      { ...baseline, samples: 9_999 },
      B_BAR,
    );
    expect(insufficient.ok).toBe(false);
    expect(insufficient.failures).toContain("insufficient sample");
  });

  it("applies tighter A thresholds without changing the protocol", () => {
    const enabled: CellMetrics = {
      p50Ms: 11, // +10%
      p99Ms: 24, // +20%
      throughputRps: 900, // 0.90
      samples: 12_000,
    };
    expect(evaluateOverheadCell(baseline, enabled, A_BAR).ok).toBe(true);
    expect(
      evaluateOverheadCell(baseline, { ...enabled, p50Ms: 11.1 }, A_BAR).ok,
    ).toBe(false);
  });

  it("requires at least 2 of 3 trial passes for variance control", () => {
    expect(evaluateVariance([true, true, false])).toEqual({
      ok: true,
      passes: 2,
      trials: 3,
    });
    expect(evaluateVariance([true, false, false])).toEqual({
      ok: false,
      passes: 1,
      trials: 3,
    });
    expect(evaluateVariance([true])).toEqual({
      ok: true,
      passes: 1,
      trials: 1,
    });
  });

  it("exposes locked B and A threshold constants", () => {
    const expectedB: OverheadThresholds = {
      maxP50Increase: 0.2,
      maxP99Increase: 0.4,
      minThroughputRatio: 0.8,
      minSamples: 10_000,
    };
    const expectedA: OverheadThresholds = {
      maxP50Increase: 0.1,
      maxP99Increase: 0.2,
      minThroughputRatio: 0.9,
      minSamples: 10_000,
    };
    expect(B_BAR).toEqual(expectedB);
    expect(A_BAR).toEqual(expectedA);
  });

  it("fails when baseline metrics are non-positive", () => {
    const result = evaluateOverheadCell(
      { p50Ms: 0, p99Ms: 0, throughputRps: 0, samples: 12_000 },
      { p50Ms: 1, p99Ms: 1, throughputRps: 1, samples: 12_000 },
      B_BAR,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("invalid baseline metrics");
  });
});

describe("credibility headroom compare", () => {
  it("reports per-cell B metric deltas vs baseline", () => {
    const baseline = report([
      cell("S1", 50, {
        p50Increase: 0.2,
        p99Increase: 0.3,
        throughputRatio: 0.85,
      }),
    ]);
    const candidate = report([
      cell("S1", 50, {
        p50Increase: 0.1,
        p99Increase: 0.2,
        throughputRatio: 0.9,
      }),
    ]);
    const compare = compareCredibilityReports(baseline, candidate);
    expect(compare.matched).toBe(true);
    expect(compare.cells).toHaveLength(1);
    const s1 = compare.cells[0];
    expect(s1?.scenario).toBe("S1");
    expect(s1?.concurrency).toBe(50);
    expect(s1?.deltas.b.p50Increase).toBeCloseTo(-0.1);
    expect(s1?.deltas.b.p99Increase).toBeCloseTo(-0.1);
    expect(s1?.deltas.b.throughputRatio).toBeCloseTo(0.05);
    expect(s1?.deltas.a.p50Increase).toBeCloseTo(-0.1);
  });

  it("reports protocol pass/fail and variance passes vs baseline", () => {
    const baseline = report([
      cell("S2", 100, {
        p50Increase: 0.1,
        p99Increase: 0.15,
        throughputRatio: 0.95,
      }),
    ]);
    const candidate = report([
      cell("S2", 100, {
        p50Increase: 0.12,
        p99Increase: 0.18,
        throughputRatio: 0.92,
        bOk: false,
        aOk: false,
      }),
    ]);
    const compare = compareCredibilityReports(baseline, candidate);
    expect(compare.type).toBe("credibility_b_compare");
    expect(compare.cells[0]).toEqual(
      expect.objectContaining({
        protocol: {
          b: {
            baselineOk: true,
            candidateOk: false,
            baselinePasses: 3,
            baselineTrials: 3,
            candidatePasses: 0,
            candidateTrials: 3,
          },
          a: {
            baselineOk: true,
            candidateOk: false,
            baselinePasses: 3,
            baselineTrials: 3,
            candidatePasses: 0,
            candidateTrials: 3,
          },
        },
      }),
    );
  });

  it("fails compare when candidate is missing a baseline cell", () => {
    const baseline = report([
      cell("S1", 50, {
        p50Increase: 0.1,
        p99Increase: 0.1,
        throughputRatio: 0.9,
      }),
    ]);
    const compare = compareCredibilityReports(baseline, report([]));
    expect(compare.matched).toBe(false);
    expect(
      compare.failures.some((f) => f.includes("S1") && f.includes("50")),
    ).toBe(true);
  });

  it("fails compare when protocol metadata differs", () => {
    const baseline: CredibilityBReport = {
      ...report([
        cell("S1", 50, {
          p50Increase: 0.1,
          p99Increase: 0.1,
          throughputRatio: 0.9,
        }),
      ]),
      warmupMs: 10_000,
      measureMs: 30_000,
      trialsPerCell: 3,
    };
    const candidate: CredibilityBReport = {
      ...baseline,
      measureMs: 120_000,
    };
    const compare = compareCredibilityReports(baseline, candidate);
    expect(compare.matched).toBe(false);
    expect(compare.failures.some((f) => f.includes("measureMs"))).toBe(true);
  });
});
