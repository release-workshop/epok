import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { StorageProvider } from "@epok/core";
import { attachRecorder, type RecorderHandle } from "../src/index.js";
import type { RecorderStats } from "../src/stats.js";
import {
  startStatsExporter,
  statsCounterDeltas,
  type StatsExporterHandle,
  type StatsExporterSample,
} from "../src/stats-exporter.js";

describe("statsCounterDeltas", () => {
  it("subtracts monotonic counters between snapshots", () => {
    const prev = snapshot({
      observed: 10,
      finalized: 8,
      persisted: 7,
      dropped: 2,
      filtered: 1,
      elided: 0,
    });
    const next = snapshot({
      observed: 15,
      finalized: 12,
      persisted: 10,
      dropped: 3,
      filtered: 2,
      elided: 1,
    });

    expect(statsCounterDeltas(prev, next)).toEqual({
      observed: 5,
      finalized: 4,
      persisted: 3,
      dropped: 1,
      filtered: 1,
      elided: 1,
    });
  });
});

describe("startStatsExporter (unit)", () => {
  let exporter: StatsExporterHandle | undefined;

  afterEach(() => {
    exporter?.stop();
    exporter = undefined;
    vi.useRealTimers();
  });

  it("emits samples from stats() without requiring onEvent", () => {
    vi.useFakeTimers();
    const samples: StatsExporterSample[] = [];
    let current = snapshot({ observed: 1, finalized: 1, persisted: 1 });

    exporter = startStatsExporter({
      stats: () => current,
      intervalMs: 1_000,
      onSample: (sample) => {
        samples.push(sample);
      },
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]?.snapshot.observed).toBe(1);
    expect(samples[0]?.deltas.observed).toBe(0);

    current = snapshot({ observed: 4, finalized: 3, persisted: 3, dropped: 1 });
    vi.advanceTimersByTime(1_000);

    expect(samples).toHaveLength(2);
    expect(samples[1]?.snapshot.observed).toBe(4);
    expect(samples[1]?.deltas).toEqual({
      observed: 3,
      finalized: 2,
      persisted: 2,
      dropped: 1,
      filtered: 0,
      elided: 0,
    });
  });

  it("is opt-in: stop ends polling", () => {
    vi.useFakeTimers();
    const samples: StatsExporterSample[] = [];
    const current = snapshot({ observed: 1 });

    exporter = startStatsExporter({
      stats: () => current,
      intervalMs: 500,
      onSample: (sample) => {
        samples.push(sample);
      },
    });
    exporter.stop();
    vi.advanceTimersByTime(5_000);

    expect(samples).toHaveLength(1);
  });

  it("fail-open: onSample throws do not stop later samples", () => {
    vi.useFakeTimers();
    const samples: StatsExporterSample[] = [];
    let current = snapshot({ observed: 1 });
    let calls = 0;

    exporter = startStatsExporter({
      stats: () => current,
      intervalMs: 1_000,
      onSample: (sample) => {
        calls += 1;
        if (calls === 1) throw new Error("sink boom");
        samples.push(sample);
      },
    });

    current = snapshot({ observed: 2 });
    vi.advanceTimersByTime(1_000);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.deltas.observed).toBe(1);
  });

  it("can skip the initial sample", () => {
    vi.useFakeTimers();
    const samples: StatsExporterSample[] = [];
    let current = snapshot({ observed: 5 });

    exporter = startStatsExporter({
      stats: () => current,
      intervalMs: 1_000,
      emitInitial: false,
      onSample: (sample) => {
        samples.push(sample);
      },
    });

    expect(samples).toHaveLength(0);

    current = snapshot({ observed: 8 });
    vi.advanceTimersByTime(1_000);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.deltas.observed).toBe(3);
  });
});

describe("startStatsExporter (attach)", () => {
  let exporter: StatsExporterHandle | undefined;
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    exporter?.stop();
    exporter = undefined;
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("emits health counters from attachRecorder stats() without onEvent", async () => {
    const samples: StatsExporterSample[] = [];
    const recorder = attachRecorder({
      storage: memoryStorage(),
      captureMode: "full",
    });
    handle = recorder;

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await recorder.drain(2_000);

    // Start after traffic so the first sample is a stable absolute snapshot.
    exporter = startStatsExporter({
      stats: () => recorder.stats(),
      intervalMs: 60_000,
      emitInitial: true,
      onSample: (sample) => {
        samples.push(sample);
      },
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]?.snapshot.observed).toBe(1);
    expect(samples[0]?.snapshot.persisted).toBe(1);
    expect(samples[0]?.snapshot.dropped).toBe(0);
  });
});

function snapshot(partial: Partial<RecorderStats>): RecorderStats {
  return {
    observed: 0,
    finalized: 0,
    persisted: 0,
    dropped: 0,
    filtered: 0,
    elided: 0,
    queueDepth: 0,
    queueLimit: 128,
    activeContexts: 0,
    bufferedBytes: 0,
    overBudget: false,
    sheddingActive: false,
    byteBudgetExhausted: false,
    ...partial,
  };
}

function memoryStorage(): StorageProvider {
  const manifests = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  return {
    durability: "best-effort",
    async putManifest(input) {
      manifests.set(input.id, input.bytes);
    },
    async getManifest(id) {
      const bytes = manifests.get(id);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async putObject(key, bytes) {
      const created = !objects.has(key.hash);
      objects.set(key.hash, bytes);
      return { created };
    },
    async getObject(key) {
      const bytes = objects.get(key.hash);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async hasObject(key) {
      return objects.has(key.hash);
    },
  };
}

function listen(s: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    s.listen(0, "127.0.0.1", () => {
      resolve();
    });
    s.once("error", reject);
  });
}

function addressOf(s: Server): string {
  const addr = s.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  return `http://127.0.0.1:${addr.port}`;
}
