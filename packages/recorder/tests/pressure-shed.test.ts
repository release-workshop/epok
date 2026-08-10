import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRESSURE_LIMITS,
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";
import { slowStorage, unusedStorage } from "./helpers.js";

describe("default pressure concurrency", () => {
  it("keeps maxConcurrency at 2 (finalize steal is not fixed by raising it)", () => {
    expect(DEFAULT_PRESSURE_LIMITS.maxConcurrency).toBe(2);
  });
});

describe("attachRecorder pressure controls", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("sheds deterministically when the persist queue is full and keeps host errors at zero", async () => {
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage: slowStorage(200),
      captureMode: "full",
      pressure: {
        maxQueueDepth: 2,
        maxConcurrency: 1,
        maxActiveContexts: 1_000,
        maxBufferedBytes: 16 * 1024 * 1024,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${base}/`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }

    await handle.drain(3_000);
    const stats = handle.pressureStats();
    expect(stats.observed).toBe(40);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.dropped / stats.observed).toBeGreaterThanOrEqual(0.5);

    expect(events.some((e) => e.type === "shedding" && e.active)).toBe(true);
    expect(events.some((e) => e.type === "queue_depth")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "interaction_dropped" && e.reason === "queue_full",
      ),
    ).toBe(true);
  });

  it("sheds when active context budget is exhausted without failing the host", async () => {
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage: slowStorage(300),
      captureMode: "full",
      pressure: {
        maxQueueDepth: 100,
        maxConcurrency: 1,
        maxActiveContexts: 2,
        maxBufferedBytes: 16 * 1024 * 1024,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 50);
    });
    await listen(server);
    const base = addressOf(server);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${base}/`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    await handle.drain(3_000);
    const stats = handle.pressureStats();
    expect(stats.observed).toBe(20);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_dropped" &&
          e.reason === "active_contexts_budget",
      ),
    ).toBe(true);
  });

  it("persists Interactions under budget through the background queue", async () => {
    const events: RecorderWideEvent[] = [];
    const storage = unusedStorage();
    let persisted = 0;
    const realPutManifest = storage.putManifest.bind(storage);
    storage.putManifest = async (input) => {
      persisted += 1;
      // no-op success
      void realPutManifest;
      void input;
    };
    storage.putObject = async () => ({ created: true });

    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16 * 1024 * 1024,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    await handle.drain(2_000);

    expect(persisted).toBe(1);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_persisted" ||
          e.type === "interaction_finalized",
      ),
    ).toBe(true);
    expect(handle.pressureStats().dropped).toBe(0);
  });
});

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
