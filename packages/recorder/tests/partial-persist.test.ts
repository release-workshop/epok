import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest, StorageProvider } from "@epok/core";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";

describe("partial/aborted persistence (attachRecorder)", () => {
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

  it("full mode persists client abort as response null, not a default 200", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "full",
    });

    let accepted!: () => void;
    const acceptedRequest = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    server = createServer((_req, _res) => {
      accepted();
      // Never write a response — client will abort.
    });
    await listen(server);
    const base = addressOf(server);

    const ac = new AbortController();
    const pending = fetch(`${base}/hang`, { signal: ac.signal });
    await acceptedRequest;
    ac.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => storage.manifests.size, { timeout: 2_000 }).toBe(1);
    const manifest = readManifest(storage);
    expect(manifest.response).toBeNull();
    expect(manifest.inbound.method).toBe("GET");
    expect(manifest.inbound.url).toContain("/hang");
  });

  it("errors mode drops hangup without host error as capture_mode_filter", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "errors",
      onEvent: (e) => events.push(e),
    });

    let accepted!: () => void;
    const acceptedRequest = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    server = createServer((_req, _res) => {
      accepted();
    });
    await listen(server);
    const base = addressOf(server);

    const ac = new AbortController();
    const pending = fetch(`${base}/hang`, { signal: ac.signal });
    await acceptedRequest;
    ac.abort();
    await expect(pending).rejects.toThrow();
    await handle.drain(2_000);
    await expect
      .poll(
        () =>
          events.some(
            (e) =>
              e.type === "interaction_dropped" &&
              e.reason === "capture_mode_filter",
          ),
        { timeout: 2_000 },
      )
      .toBe(true);

    expect(storage.manifests.size).toBe(0);
  });

  it("5xx with a missing-await fetch persists an unterminated invoke-ordered row", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "errors",
    });

    dependencyServer = createServer((_req, _res) => {
      // Hang so the outbound is still in flight at inbound terminal.
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer((_req, res) => {
      void fetch(`${depBase}/slow`).catch(() => undefined);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(500);
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(1);
    const manifest = readManifest(storage);
    expect(manifest.response).not.toBeNull();
    expect(manifest.response?.status).toBe(500);
    expect(manifest.dependencies).toHaveLength(1);
    const dep = manifest.dependencies[0];
    expect(dep).toBeDefined();
    if (dep === undefined) return;
    expect(dep.seq).toBe(1);
    expect(dep.request.method).toBe("GET");
    expect(dep.request.url).toContain("/slow");
    expect(dep.response).toBeNull();
    expect(dep.error).toBeUndefined();
    expect(dep.endedAt).toBeGreaterThanOrEqual(dep.startedAt);
  });

  it("does not patch an in-flight fetch that completes after inbound terminal", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "errors",
    });

    let releaseDep!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseDep = resolve;
    });
    dependencyServer = createServer((_req, res) => {
      void released.then(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      });
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer((_req, res) => {
      void fetch(`${depBase}/slow`).catch(() => undefined);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(500);
    await handle.drain(2_000);

    const before = readManifest(storage);
    expect(before.dependencies[0]?.response).toBeNull();

    releaseDep();
    await new Promise((r) => setTimeout(r, 50));
    await handle.drain(2_000);

    const after = readManifest(storage);
    expect(after.integrity.manifestHash).toBe(before.integrity.manifestHash);
    expect(after.dependencies[0]?.response).toBeNull();
    expect(after.dependencies[0]?.error).toBeUndefined();
  });

  it("persists an empty inbound body when the request stream never ends", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "full",
    });

    let accepted!: () => void;
    const acceptedRequest = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    server = createServer((req, _res) => {
      req.resume();
      accepted();
    });
    await listen(server);
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected TCP address");
    }

    const socket = connect(addr.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npartial-prefix",
    );
    await acceptedRequest;
    socket.destroy();
    await expect.poll(() => storage.manifests.size, { timeout: 2_000 }).toBe(1);

    const manifest = readManifest(storage);
    expect(manifest.response).toBeNull();
    expect(manifest.inbound.body.cas.size).toBe(0);
  });
});

function readManifest(
  storage: StorageProvider & { manifests: Map<string, Uint8Array> },
): InteractionManifest {
  const first = [...storage.manifests.entries()][0];
  if (first === undefined) {
    throw new Error("expected a persisted manifest");
  }
  return JSON.parse(new TextDecoder().decode(first[1])) as InteractionManifest;
}

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
