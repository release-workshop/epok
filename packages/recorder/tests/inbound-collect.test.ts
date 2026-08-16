import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest, StorageProvider } from "@epok/core";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";
import { createCaptureContext } from "../src/context.js";

describe("createCaptureContext identity", () => {
  it("defers id allocation until interactionId is read", () => {
    let allocations = 0;
    const ctx = createCaptureContext(false, () => {
      allocations += 1;
      return `id-${allocations}`;
    });
    expect(allocations).toBe(0);
    expect(ctx.interactionId).toBe("id-1");
    expect(allocations).toBe(1);
    expect(ctx.interactionId).toBe("id-1");
    expect(allocations).toBe(1);
  });
});

describe("attachRecorder inbound body collect", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("persists inbound body bytes for POST with a framed body", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      onEvent: (e) => events.push(e),
    });

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });
    await listen(server);
    const base = addressOf(server);

    const payload = JSON.stringify({ amount: 42 });
    const response = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    await handle.drain(2_000);
    const persisted = events.find((e) => e.type === "interaction_persisted");
    expect(persisted?.type).toBe("interaction_persisted");
    if (persisted?.type !== "interaction_persisted") return;

    const manifest = await loadManifest(storage, persisted.interactionId);
    const inboundBytes = await resolveInboundBodyBytes(storage, manifest);
    expect(new TextDecoder().decode(inboundBytes)).toBe(payload);
  });

  it("finalizes GET with empty inbound body without host failure", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "full",
      onEvent: (e) => events.push(e),
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    await handle.drain(2_000);
    const persisted = events.find((e) => e.type === "interaction_persisted");
    expect(persisted?.type).toBe("interaction_persisted");
    if (persisted?.type !== "interaction_persisted") return;

    const manifest = await loadManifest(storage, persisted.interactionId);
    const inboundBytes = await resolveInboundBodyBytes(storage, manifest);
    expect(inboundBytes.byteLength).toBe(0);
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

async function loadManifest(
  storage: StorageProvider,
  id: string,
): Promise<InteractionManifest> {
  const bytes = await storage.getManifest(id);
  return JSON.parse(new TextDecoder().decode(bytes)) as InteractionManifest;
}

async function resolveInboundBodyBytes(
  storage: StorageProvider,
  manifest: InteractionManifest,
): Promise<Uint8Array> {
  const hash = manifest.inbound.body.cas.hash;
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
