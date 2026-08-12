import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageProvider } from "@epok/core";
import { attachRecorder, type RecorderHandle } from "../src/index.js";
import { slowStorage } from "./helpers.js";

describe("attachRecorder stats()", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("returns a snapshot without requiring onEvent", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({ storage, captureMode: "full" });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    const stats = handle.stats();
    expect(stats.observed).toBe(1);
    expect(stats.finalized).toBe(1);
    expect(stats.persisted).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(stats.filtered).toBe(0);
    expect(stats.queueLimit).toBeGreaterThan(0);
  });

  it("increments filtered under errors captureMode without onEvent", async () => {
    handle = attachRecorder({ storage: memoryStorage() });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    const stats = handle.stats();
    expect(stats.observed).toBe(1);
    expect(stats.filtered).toBe(1);
    expect(stats.finalized).toBe(0);
    expect(stats.persisted).toBe(0);
    expect(stats.dropped).toBe(0);
  });

  it("increments dropped under pressure shed without onEvent", async () => {
    handle = attachRecorder({
      storage: slowStorage(200),
      captureMode: "full",
      pressure: {
        maxQueueDepth: 2,
        maxConcurrency: 1,
        maxActiveContexts: 1_000,
        maxBufferedBytes: 16 * 1024 * 1024,
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/`)));
    await handle.drain(3_000);

    const stats = handle.stats();
    expect(stats.observed).toBe(20);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.sheddingActive || stats.overBudget).toBe(true);
  });

  it("increments elided under byte-budget body elision without onEvent", async () => {
    handle = attachRecorder({
      storage: memoryStorage(),
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16,
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(64));
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    const stats = handle.stats();
    expect(stats.observed).toBe(1);
    expect(stats.elided).toBeGreaterThan(0);
    expect(stats.dropped).toBe(0);
    expect(stats.persisted).toBe(1);
  });

  it("pressureStats() is a deprecated alias of stats()", async () => {
    handle = attachRecorder({ storage: memoryStorage(), captureMode: "full" });

    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await listen(server);
    await fetch(`${addressOf(server)}/`);
    await handle.drain(2_000);

    const stats = handle.stats();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- verify deprecated alias
    expect(handle.pressureStats()).toEqual(stats);
  });
});

function memoryStorage(): StorageProvider & {
  manifests: Map<string, Uint8Array>;
} {
  const manifests = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  return {
    durability: "best-effort",
    manifests,
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
