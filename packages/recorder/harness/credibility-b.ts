/**
 * Production-credibility harness (Slice 8 / B bar).
 *
 * Workload: Node HTTP inbound (~1KB) + one outbound fetch dependency (~1KB).
 * Scenarios: S1 dep ~1.5ms, S2 dep ~10ms. Concurrency matrix [50, 100].
 * Compares recorder=disabled structural no-op vs recorder=enabled.
 *
 * Profiles:
 *   premerge  — 10s warmup + 30s measure (CI B gate)
 *   postmerge — 10s warmup + 120s measure (longer verification)
 *
 * Run:
 *   pnpm --filter @epok/recorder credibility:b -- --profile premerge --out results.json
 * Compare to frozen headroom baseline:
 *   pnpm --filter @epok/recorder credibility:b -- --compare harness/baselines/credibility-b-headroom.json results.json
 */
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import type { StorageProvider } from "@epok/core";
import {
  A_BAR,
  B_BAR,
  compareCredibilityReports,
  evaluateOverheadCell,
  evaluateVariance,
  summarizeLatencies,
  type CellMetrics,
  type OverheadCellResult,
} from "../dist/credibility.js";
import { attachRecorder, type RecorderHandle } from "../dist/index.js";

const BODY_1KB = Buffer.alloc(1024, 0x61);
const SCENARIOS = {
  S1: { name: "S1", dependencyDelayMs: 1.5 },
  S2: { name: "S2", dependencyDelayMs: 10 },
} as const;
const DEFAULT_CONCURRENCIES = [50, 100] as const;

type ProfileName = "premerge" | "postmerge";

interface Profile {
  name: ProfileName;
  warmupMs: number;
  measureMs: number;
}

const PROFILES: Record<ProfileName, Profile> = {
  premerge: { name: "premerge", warmupMs: 10_000, measureMs: 30_000 },
  postmerge: { name: "postmerge", warmupMs: 10_000, measureMs: 120_000 },
};

interface CliOptions {
  profile: Profile;
  trials: number;
  outPath: string | null;
  warmupMs: number;
  measureMs: number;
  minSamples: number;
  concurrencies: number[];
  scenarios: (keyof typeof SCENARIOS)[];
}

interface LoadResult {
  latenciesMs: number[];
  errors: number;
  durationMs: number;
}

interface ModeRun {
  mode: "disabled" | "enabled";
  metrics: CellMetrics;
  errors: number;
}

interface TrialCell {
  trial: number;
  baseline: ModeRun;
  enabled: ModeRun;
  b: OverheadCellResult;
  a: OverheadCellResult;
}

interface CellReport {
  scenario: string;
  dependencyDelayMs: number;
  concurrency: number;
  trials: TrialCell[];
  bVariance: ReturnType<typeof evaluateVariance>;
  aVariance: ReturnType<typeof evaluateVariance>;
}

function parseArgs(argv: string[]): CliOptions {
  const profileName = (flag(argv, "--profile") ?? "premerge") as ProfileName;
  if (!(profileName in PROFILES)) {
    throw new Error(`unknown --profile ${profileName}`);
  }
  const profile = PROFILES[profileName];
  const concurrencies = (flag(argv, "--concurrency") ?? "50,100")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const scenarios = (flag(argv, "--scenarios") ?? "S1,S2")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is keyof typeof SCENARIOS => s in SCENARIOS);

  return {
    profile,
    trials: Number(flag(argv, "--trials") ?? 3),
    outPath: flag(argv, "--out"),
    warmupMs: Number(flag(argv, "--warmup-ms") ?? profile.warmupMs),
    measureMs: Number(flag(argv, "--measure-ms") ?? profile.measureMs),
    minSamples: Number(flag(argv, "--min-samples") ?? B_BAR.minSamples),
    concurrencies,
    scenarios,
  };
}

function flag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function fastMemoryStorage(): StorageProvider {
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
      const k = `${key.alg}:${key.hash}`;
      const created = !objects.has(k);
      objects.set(k, bytes);
      return { created };
    },
    async getObject(key) {
      const bytes = objects.get(`${key.alg}:${key.hash}`);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async hasObject(key) {
      return objects.has(`${key.alg}:${key.hash}`);
    },
  };
}

function listen(server: Server): Promise<{ port: number; base: string }> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      resolve({
        port: addr.port,
        base: `http://127.0.0.1:${addr.port}`,
      });
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function runLoad(
  base: string,
  concurrency: number,
  durationMs: number,
): Promise<LoadResult> {
  const latenciesMs: number[] = [];
  let errors = 0;
  let stop = false;
  const started = performance.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (!stop) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}/`);
        const text = await res.text();
        if (res.status !== 200 || text.length === 0) {
          errors += 1;
        } else {
          latenciesMs.push(performance.now() - t0);
        }
      } catch {
        errors += 1;
      }
    }
  });

  await new Promise((r) => setTimeout(r, durationMs));
  stop = true;
  await Promise.all(workers);
  return {
    latenciesMs,
    errors,
    durationMs: performance.now() - started,
  };
}

function toMetrics(load: LoadResult): CellMetrics {
  const summary = summarizeLatencies(load.latenciesMs);
  const throughputRps =
    load.durationMs <= 0 ? 0 : summary.samples / (load.durationMs / 1000);
  return {
    p50Ms: summary.p50Ms,
    p99Ms: summary.p99Ms,
    throughputRps,
    samples: summary.samples,
  };
}

async function measureMode(opts: {
  appBase: string;
  concurrency: number;
  warmupMs: number;
  measureMs: number;
  enabled: boolean;
}): Promise<{ handle: RecorderHandle; metrics: CellMetrics; errors: number }> {
  const handle = attachRecorder({
    storage: fastMemoryStorage(),
    enabled: opts.enabled,
    // High queue/context ceilings so the B bar measures capture cost, not shedding.
    // Keep maxConcurrency near defaults so background finalize does not flood the event loop.
    pressure: {
      maxQueueDepth: 50_000,
      maxConcurrency: 2,
      maxActiveContexts: 50_000,
      maxBufferedBytes: 512 * 1024 * 1024,
    },
  });

  await runLoad(opts.appBase, opts.concurrency, opts.warmupMs);
  await handle.drain(5_000);
  const measured = await runLoad(
    opts.appBase,
    opts.concurrency,
    opts.measureMs,
  );
  await handle.drain(10_000);

  return {
    handle,
    metrics: toMetrics(measured),
    errors: measured.errors,
  };
}

async function runCell(opts: {
  scenario: keyof typeof SCENARIOS;
  concurrency: number;
  warmupMs: number;
  measureMs: number;
  trials: number;
  minSamples: number;
}): Promise<CellReport> {
  const scenario = SCENARIOS[opts.scenario];
  const depServer = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": BODY_1KB.length,
      });
      res.end(BODY_1KB);
    }, scenario.dependencyDelayMs);
  });
  const dep = await listen(depServer);

  const appServer = createServer((_req, res) => {
    void (async () => {
      try {
        const upstream = await fetch(`${dep.base}/dep`);
        await upstream.arrayBuffer();
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": BODY_1KB.length,
        });
        res.end(BODY_1KB);
      } catch {
        res.writeHead(500);
        res.end("err");
      }
    })();
  });
  const app = await listen(appServer);

  const bThresholds = { ...B_BAR, minSamples: opts.minSamples };
  const aThresholds = { ...A_BAR, minSamples: opts.minSamples };
  const trials: TrialCell[] = [];

  try {
    for (let trial = 1; trial <= opts.trials; trial += 1) {
      const baselineRun = await measureMode({
        appBase: app.base,
        concurrency: opts.concurrency,
        warmupMs: opts.warmupMs,
        measureMs: opts.measureMs,
        enabled: false,
      });
      baselineRun.handle.detach();

      const enabledRun = await measureMode({
        appBase: app.base,
        concurrency: opts.concurrency,
        warmupMs: opts.warmupMs,
        measureMs: opts.measureMs,
        enabled: true,
      });
      enabledRun.handle.detach();

      const baseline: ModeRun = {
        mode: "disabled",
        metrics: baselineRun.metrics,
        errors: baselineRun.errors,
      };
      const enabled: ModeRun = {
        mode: "enabled",
        metrics: enabledRun.metrics,
        errors: enabledRun.errors,
      };

      trials.push({
        trial,
        baseline,
        enabled,
        b: evaluateOverheadCell(
          baseline.metrics,
          enabled.metrics,
          bThresholds,
          "B",
        ),
        a: evaluateOverheadCell(
          baseline.metrics,
          enabled.metrics,
          aThresholds,
          "A",
        ),
      });
    }
  } finally {
    await closeServer(appServer);
    await closeServer(depServer);
  }

  return {
    scenario: scenario.name,
    dependencyDelayMs: scenario.dependencyDelayMs,
    concurrency: opts.concurrency,
    trials,
    bVariance: evaluateVariance(trials.map((t) => t.b.ok)),
    aVariance: evaluateVariance(trials.map((t) => t.a.ok)),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (hasFlag(argv, "--help")) {
    console.log(`Usage: credibility-b --profile premerge|postmerge [options]
  --trials N           default 3
  --out path           write JSON report
  --warmup-ms N        override profile warmup
  --measure-ms N       override profile measure window
  --min-samples N      override sample validity gate (default 10000)
  --concurrency a,b    default 50,100
  --scenarios S1,S2    default S1,S2

Compare a new report to a frozen headroom baseline (no load run):
  credibility-b --compare <baseline.json> <candidate.json> [--out compare.json]`);
    return;
  }

  if (hasFlag(argv, "--compare")) {
    await runCompare(argv);
    return;
  }

  const opts = parseArgs(argv);
  const started = Date.now();
  const cells: CellReport[] = [];

  for (const scenario of opts.scenarios) {
    for (const concurrency of opts.concurrencies) {
      console.error(
        `cell ${scenario} c=${concurrency} trials=${opts.trials} warmup=${opts.warmupMs}ms measure=${opts.measureMs}ms`,
      );
      const cell = await runCell({
        scenario,
        concurrency,
        warmupMs: opts.warmupMs,
        measureMs: opts.measureMs,
        trials: opts.trials,
        minSamples: opts.minSamples,
      });
      cells.push(cell);
      console.error(
        `  B variance ${cell.bVariance.passes}/${cell.bVariance.trials} ok=${cell.bVariance.ok}; A report ${cell.aVariance.passes}/${cell.aVariance.trials} ok=${cell.aVariance.ok}`,
      );
    }
  }

  const bOk = cells.every((c) => c.bVariance.ok);
  const aOk = cells.every((c) => c.aVariance.ok);

  const report = {
    type: "credibility_b_report",
    profile: opts.profile.name,
    warmupMs: opts.warmupMs,
    measureMs: opts.measureMs,
    trialsPerCell: opts.trials,
    minSamples: opts.minSamples,
    thresholds: { B: B_BAR, A: A_BAR },
    durationMs: Date.now() - started,
    cells,
    bGate: {
      ok: bOk,
      blocking: true,
      cells: cells.map((c) => ({
        scenario: c.scenario,
        concurrency: c.concurrency,
        ok: c.bVariance.ok,
        passes: c.bVariance.passes,
        trials: c.bVariance.trials,
      })),
    },
    aReport: {
      ok: aOk,
      blocking: false,
      note: "A bar is reported for later promotion; does not fail this gate",
      cells: cells.map((c) => ({
        scenario: c.scenario,
        concurrency: c.concurrency,
        ok: c.aVariance.ok,
        passes: c.aVariance.passes,
        trials: c.aVariance.trials,
      })),
    },
  };

  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (opts.outPath) {
    await writeFile(opts.outPath, `${json}\n`, "utf8");
    console.error(`wrote ${opts.outPath}`);
  }

  if (!bOk) {
    console.error("FAIL: B gate");
    process.exitCode = 1;
    return;
  }
  console.error("PASS: B gate");
}

async function loadReport(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function runCompare(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--compare");
  const baselinePath = argv[idx + 1];
  const candidatePath = argv[idx + 2];
  if (!baselinePath || !candidatePath || baselinePath.startsWith("--")) {
    throw new Error(
      "usage: credibility-b --compare <baseline.json> <candidate.json> [--out compare.json]",
    );
  }
  const outPath = flag(argv, "--out");
  const compare = compareCredibilityReports(
    await loadReport(baselinePath),
    await loadReport(candidatePath),
  );
  const json = JSON.stringify(compare, null, 2);
  console.log(json);
  if (outPath) {
    await writeFile(outPath, `${json}\n`, "utf8");
    console.error(`wrote ${outPath}`);
  }
  if (!compare.matched) {
    console.error("FAIL: credibility compare (cell set or protocol metadata)");
    process.exitCode = 1;
    return;
  }
  console.error(
    "PASS: credibility compare (cells + protocol metadata matched; see cells[].protocol for B/A variance)",
  );
}

await main();
