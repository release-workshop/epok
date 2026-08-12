import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";
import { validateReplay } from "@epok/replay";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";

describe("attachRecorder body-elision shed", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;
  let dependencyServer: Server | undefined;

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
    dependencyServer?.close();
    dependencyServer = undefined;
  });

  it("elides bodies under byte-budget pressure, persists a valid Interaction, and keeps host errors at zero", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    const payload = "x".repeat(64);
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(payload);
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);

    await handle.drain(2_000);

    expect(handle.pressureStats().dropped).toBe(0);
    expect(events.some((e) => e.type === "body_elided")).toBe(true);
    expect(storage.manifests.size).toBe(1);

    const first = [...storage.manifests.entries()][0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [id, bytes] = first;
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as InteractionManifest;
    expect(manifest.response.body.cas.hash).toBe(EMPTY_BODY_SHA256);
    expect(manifest.response.body.cas.size).toBe(0);
    expect(manifest.response.status).toBe(200);

    const validated = await validateReplay({ storage, interactionId: id });
    expect(validated.ok).toBe(true);
  });

  it("elides already-buffered body chunks instead of persisting a partial payload", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 24,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("abcdefghij");
      res.end("x".repeat(32));
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abcdefghij" + "x".repeat(32));

    await handle.drain(2_000);

    expect(events.some((e) => e.type === "body_elided")).toBe(true);
    expect(storage.manifests.size).toBe(1);
    const first = [...storage.manifests.values()][0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const manifest = JSON.parse(
      new TextDecoder().decode(first),
    ) as InteractionManifest;
    expect(manifest.response.body.cas.hash).toBe(EMPTY_BODY_SHA256);
    expect(manifest.response.body.cas.size).toBe(0);
  });

  it("drops the Interaction on byte-budget pressure when body elision is disabled", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16,
        bodyElision: false,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    const payload = "x".repeat(64);
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(payload);
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);

    await handle.drain(2_000);

    expect(handle.pressureStats().dropped).toBeGreaterThan(0);
    expect(storage.manifests.size).toBe(0);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_dropped" &&
          e.reason === "buffered_bytes_budget",
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "body_elided")).toBe(false);
  });

  it("keeps host errors at zero under concurrent large-body overload with elision", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 64,
        maxConcurrency: 2,
        maxActiveContexts: 64,
        maxBufferedBytes: 32,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    const payload = "y".repeat(128);
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(payload);
    });
    await listen(server);
    const base = addressOf(server);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${base}/`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(payload);
    }

    await handle.drain(3_000);

    expect(handle.pressureStats().observed).toBe(20);
    expect(handle.pressureStats().dropped).toBe(0);
    expect(events.some((e) => e.type === "body_elided")).toBe(true);
    expect(storage.manifests.size).toBe(20);

    for (const [id, bytes] of storage.manifests) {
      const manifest = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as InteractionManifest;
      expect(manifest.response.body.cas.hash).toBe(EMPTY_BODY_SHA256);
      const validated = await validateReplay({ storage, interactionId: id });
      expect(validated.ok).toBe(true);
    }
  });

  it("skips capturing outbound bodies after elision while the app still consumes them", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16,
      },
      onEvent: (e) => {
        events.push(e);
      },
    });

    const depPayload = "z".repeat(64);
    dependencyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(depPayload);
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer(async (_req, res) => {
      const upstream = await fetch(`${depBase}/dep`);
      const text = await upstream.text();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(text);
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(depPayload);

    await handle.drain(2_000);

    expect(events.some((e) => e.type === "body_elided")).toBe(true);
    expect(storage.manifests.size).toBeGreaterThan(0);

    const appManifest = [...storage.manifests.values()]
      .map(
        (bytes) =>
          JSON.parse(new TextDecoder().decode(bytes)) as InteractionManifest,
      )
      .find((manifest) => manifest.dependencies.length > 0);
    expect(appManifest).toBeDefined();
    if (appManifest === undefined) return;
    expect(appManifest.response.body.cas.hash).toBe(EMPTY_BODY_SHA256);
    const dep = appManifest.dependencies[0];
    expect(dep).toBeDefined();
    if (dep === undefined) return;
    expect(dep.response).not.toBeNull();
    if (dep.response === null) return;
    expect(dep.response.body.cas.hash).toBe(EMPTY_BODY_SHA256);
    expect(dep.request.body.cas.hash).toBe(EMPTY_BODY_SHA256);
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
      const stored = manifests.get(id);
      if (!stored) throw new Error("not found");
      return stored;
    },
    async putObject(key, bytes) {
      const created = !objects.has(key.hash);
      objects.set(key.hash, bytes);
      return { created };
    },
    async getObject(key) {
      const stored = objects.get(key.hash);
      if (!stored) throw new Error("not found");
      return stored;
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
