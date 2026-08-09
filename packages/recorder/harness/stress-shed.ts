/**
 * Local stress harness for Slice 7 pressure controls.
 *
 * Proves:
 * - host errors remain zero under forced overload
 * - any continuous 10s over-budget window can show >=80% dropped/observed
 * - capture/queue memory stays within configured pressure limits; RSS does not
 *   climb unboundedly during a sustained over-budget window
 *
 * Run (from repo root, after build):
 *   pnpm --filter @epok/recorder stress:shed
 */
import { createServer } from "node:http";
import type { StorageProvider } from "@epok/core";
import { attachRecorder, type RecorderWideEvent } from "../dist/index.js";

const QUEUE_LIMIT = 4;
const MAX_ACTIVE_CONTEXTS = 16;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 20;
/** Pace each worker so HTTP stack RSS does not dominate the bound check. */
const CLIENT_PAUSE_MS = 5;
const RUN_MS = 12_000;
const WINDOW_MS = 10_000;
const SAMPLE_MS = 100;
/** Max RSS climb inside a continuous over-budget window (plateau check). */
const MAX_WINDOW_RSS_DELTA_BYTES = 50 * 1024 * 1024;
const PERSIST_DELAY_MS = 100;

interface Sample {
  at: number;
  observed: number;
  dropped: number;
  overBudget: boolean;
  rss: number;
  bufferedBytes: number;
  activeContexts: number;
  queueDepth: number;
}

function slowStorage(delayMs: number): StorageProvider {
  return {
    durability: "best-effort",
    async putManifest() {
      await new Promise((r) => setTimeout(r, delayMs));
    },
    async getManifest() {
      throw new Error("unused");
    },
    async putObject() {
      await new Promise((r) => setTimeout(r, delayMs));
      return { created: true };
    },
    async getObject() {
      throw new Error("unused");
    },
    async hasObject() {
      return false;
    },
  };
}

function rssBytes(): number {
  return process.memoryUsage().rss;
}

async function main(): Promise<void> {
  let hostErrors = 0;
  let sheddingActivations = 0;
  let queueDepthEvents = 0;

  const handle = attachRecorder({
    storage: slowStorage(PERSIST_DELAY_MS),
    pressure: {
      maxQueueDepth: QUEUE_LIMIT,
      maxConcurrency: 1,
      maxActiveContexts: MAX_ACTIVE_CONTEXTS,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
    },
    onEvent: (e: RecorderWideEvent) => {
      // Count only — never retain event payloads (would defeat the memory bound).
      if (e.type === "shedding" && e.active) sheddingActivations += 1;
      if (e.type === "queue_depth") queueDepthEvents += 1;
    },
  });

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  const base = `http://127.0.0.1:${addr.port}`;

  // Warm attach + one persist cycle before measuring.
  for (let i = 0; i < 20; i += 1) {
    await fetch(`${base}/`).then((r) => r.text());
  }
  await handle.drain(3_000);
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
  }

  const samples: Sample[] = [];
  const started = Date.now();

  const sampler = setInterval(() => {
    const stats = handle.pressureStats();
    samples.push({
      at: Date.now(),
      observed: stats.observed,
      dropped: stats.dropped,
      overBudget: stats.overBudget,
      rss: rssBytes(),
      bufferedBytes: stats.bufferedBytes,
      activeContexts: stats.activeContexts,
      queueDepth: stats.queueDepth,
    });
  }, SAMPLE_MS);

  let stop = false;
  const workers: Promise<void>[] = [];

  for (let i = 0; i < CONCURRENCY; i += 1) {
    workers.push(
      (async () => {
        while (!stop) {
          try {
            const res = await fetch(`${base}/`);
            if (res.status !== 200) hostErrors += 1;
            await res.text();
          } catch {
            hostErrors += 1;
          }
          await new Promise((r) => setTimeout(r, CLIENT_PAUSE_MS));
        }
      })(),
    );
  }

  await new Promise((r) => setTimeout(r, RUN_MS));
  stop = true;
  await Promise.all(workers);
  clearInterval(sampler);
  await handle.drain(5_000);

  const finalStats = handle.pressureStats();
  handle.detach();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  let bestRatio = 0;
  let foundWindow = false;
  let windowRssDelta = 0;
  let maxBuffered = 0;
  let maxActive = 0;
  let maxQueue = 0;
  for (const s of samples) {
    maxBuffered = Math.max(maxBuffered, s.bufferedBytes);
    maxActive = Math.max(maxActive, s.activeContexts);
    maxQueue = Math.max(maxQueue, s.queueDepth);
  }

  for (let i = 0; i < samples.length; i += 1) {
    const start = samples[i]!;
    const endAt = start.at + WINDOW_MS;
    const windowSamples = samples.filter(
      (s) => s.at >= start.at && s.at <= endAt,
    );
    if (windowSamples.length < 2) continue;
    const last = windowSamples[windowSamples.length - 1]!;
    if (last.at - start.at < WINDOW_MS - SAMPLE_MS) continue;
    const continuous = windowSamples.every((s) => s.overBudget);
    if (!continuous) continue;
    foundWindow = true;
    const dObs = last.observed - start.observed;
    const dDrop = last.dropped - start.dropped;
    if (dObs <= 0) continue;
    const ratio = dDrop / dObs;
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      const rssValues = windowSamples.map((s) => s.rss);
      windowRssDelta = Math.max(...rssValues) - Math.min(...rssValues);
    }
  }

  const report = {
    type: "stress_shed_report",
    durationMs: Date.now() - started,
    hostErrors,
    observed: finalStats.observed,
    dropped: finalStats.dropped,
    overallDropRatio:
      finalStats.observed === 0 ? 0 : finalStats.dropped / finalStats.observed,
    foundOverBudgetWindow: foundWindow,
    bestWindowDropRatio: bestRatio,
    windowRssDeltaBytes: windowRssDelta,
    maxWindowRssDeltaBudgetBytes: MAX_WINDOW_RSS_DELTA_BYTES,
    maxBufferedBytesSeen: maxBuffered,
    maxBufferedBytesLimit: MAX_BUFFERED_BYTES,
    maxActiveContextsSeen: maxActive,
    maxActiveContextsLimit: MAX_ACTIVE_CONTEXTS,
    maxQueueDepthSeen: maxQueue,
    maxQueueDepthLimit: QUEUE_LIMIT,
    sheddingActivations,
    queueDepthEvents,
  };
  console.log(JSON.stringify(report, null, 2));

  const failures: string[] = [];
  if (hostErrors !== 0) {
    failures.push(`hostErrors=${hostErrors} (want 0)`);
  }
  if (!foundWindow) {
    failures.push("no continuous 10s over-budget window observed");
  } else if (bestRatio < 0.8) {
    failures.push(
      `best over-budget window drop ratio ${bestRatio.toFixed(3)} < 0.80`,
    );
  }
  if (maxBuffered > MAX_BUFFERED_BYTES) {
    failures.push(
      `bufferedBytes ${maxBuffered} exceeded limit ${MAX_BUFFERED_BYTES}`,
    );
  }
  if (maxActive > MAX_ACTIVE_CONTEXTS) {
    failures.push(
      `activeContexts ${maxActive} exceeded limit ${MAX_ACTIVE_CONTEXTS}`,
    );
  }
  if (maxQueue > QUEUE_LIMIT) {
    failures.push(`queueDepth ${maxQueue} exceeded limit ${QUEUE_LIMIT}`);
  }
  if (foundWindow && windowRssDelta > MAX_WINDOW_RSS_DELTA_BYTES) {
    failures.push(
      `over-budget window RSS delta ${windowRssDelta} exceeds budget ${MAX_WINDOW_RSS_DELTA_BYTES}`,
    );
  }

  if (failures.length > 0) {
    console.error("FAIL:", failures.join("; "));
    process.exitCode = 1;
    return;
  }
  console.error("PASS");
}

await main();
