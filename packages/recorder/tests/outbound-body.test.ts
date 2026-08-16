import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest, StorageProvider } from "@epok/core";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";

describe("attachRecorder outbound body collect", () => {
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

  it("persists dependency response bytes while the app also consumes the body", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      onEvent: (e) => events.push(e),
    });

    const depPayload = "dependency-payload";
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
    const manifest = await loadAppManifest(storage, events);
    const dep = manifest.dependencies[0];
    expect(dep).toBeDefined();
    if (dep === undefined) return;
    expect(dep.response).not.toBeNull();
    if (dep.response === null) return;
    const depBytes = await resolveBodyBytes(
      storage,
      manifest,
      dep.response.body.cas.hash,
    );
    expect(new TextDecoder().decode(depBytes)).toBe(depPayload);
  });

  it("persists buffered outbound request body without host failure", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      onEvent: (e) => events.push(e),
    });

    dependencyServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    const requestPayload = JSON.stringify({ sku: "abc" });
    server = createServer(async (_req, res) => {
      const upstream = await fetch(`${depBase}/dep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestPayload,
      });
      await upstream.arrayBuffer();
      res.writeHead(200);
      res.end("done");
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);

    await handle.drain(2_000);
    const manifest = await loadAppManifest(storage, events);
    const dep = manifest.dependencies[0];
    expect(dep).toBeDefined();
    if (dep === undefined) return;
    const reqBytes = await resolveBodyBytes(
      storage,
      manifest,
      dep.request.body.cas.hash,
    );
    expect(new TextDecoder().decode(reqBytes)).toBe(requestPayload);
  });

  it("keeps host fetch succeeding when the app fully consumes the dependency body", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({ storage, captureMode: "full" });

    dependencyServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("dep");
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer(async (_req, res) => {
      const upstream = await fetch(`${depBase}/dep`);
      const text = await upstream.text();
      res.writeHead(200);
      res.end(text);
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dep");
  });
});

function memoryStorage(): StorageProvider & {
  manifests: Map<string, Uint8Array>;
  objects: Map<string, Uint8Array>;
} {
  const manifests = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  return {
    durability: "best-effort",
    manifests,
    objects,
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

async function loadAppManifest(
  storage: StorageProvider,
  events: RecorderWideEvent[],
): Promise<InteractionManifest> {
  const persistedIds = events
    .filter((e) => e.type === "interaction_persisted")
    .map((e) => e.interactionId);
  expect(persistedIds.length).toBeGreaterThan(0);
  for (const id of persistedIds) {
    const manifest = await loadManifest(storage, id);
    if (manifest.dependencies.length > 0) return manifest;
  }
  throw new Error("expected an Interaction with outbound dependencies");
}

async function loadManifest(
  storage: StorageProvider,
  id: string,
): Promise<InteractionManifest> {
  const bytes = await storage.getManifest(id);
  return JSON.parse(new TextDecoder().decode(bytes)) as InteractionManifest;
}

async function resolveBodyBytes(
  storage: StorageProvider,
  manifest: InteractionManifest,
  hash: string,
): Promise<Uint8Array> {
  const embedded = manifest.objects[hash];
  if (embedded) {
    if (embedded.encoding === "utf-8") {
      return new TextEncoder().encode(embedded.data);
    }
    return Uint8Array.from(Buffer.from(embedded.data, "base64"));
  }
  return storage.getObject({ alg: "sha256", hash });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
    server.once("error", reject);
  });
}

function addressOf(server: Server): string {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  return `http://127.0.0.1:${addr.port}`;
}
