import { describe, expect, it } from "vitest";
import {
  B_BAR,
  A_BAR,
  evaluateOverheadCell,
  evaluateVariance,
  type CellMetrics,
  type OverheadThresholds,
} from "../src/credibility.js";

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
