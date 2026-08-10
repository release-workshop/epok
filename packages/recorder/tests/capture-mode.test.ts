import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest, StorageProvider } from "@epok/core";
import {
  DEFAULT_CAPTURE_MODE,
  shouldPersistInteraction,
} from "../src/capture-mode.js";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";

describe("shouldPersistInteraction", () => {
  it("persists every Interaction in full mode", () => {
    expect(
      shouldPersistInteraction("full", {
        status: 200,
        terminalHostError: false,
      }),
    ).toBe(true);
    expect(
      shouldPersistInteraction("full", {
        status: 404,
        terminalHostError: false,
      }),
    ).toBe(true);
  });

  it("in errors mode persists only on status >= 500 or terminal host error", () => {
    expect(
      shouldPersistInteraction("errors", {
        status: 200,
        terminalHostError: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistInteraction("errors", {
        status: 404,
        terminalHostError: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistInteraction("errors", {
        status: 499,
        terminalHostError: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistInteraction("errors", {
        status: 500,
        terminalHostError: false,
      }),
    ).toBe(true);
    expect(
      shouldPersistInteraction("errors", {
        status: 503,
        terminalHostError: false,
      }),
    ).toBe(true);
    expect(
      shouldPersistInteraction("errors", {
        status: 200,
        terminalHostError: true,
      }),
    ).toBe(true);
  });

  it("defaults attach captureMode to errors", () => {
    expect(DEFAULT_CAPTURE_MODE).toBe("errors");
  });
});

describe("attachRecorder captureMode", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("default errors mode skips persist on 200 and emits capture_mode_filter", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      onEvent: (e) => events.push(e),
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(0);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_dropped" &&
          e.reason === "capture_mode_filter",
      ),
    ).toBe(true);
  });

  it("errors mode persists 500 and stamps captureMode on the manifest", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "errors",
    });

    server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(500);
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(1);
    const first = [...storage.manifests.entries()][0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, bytes] = first;
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as InteractionManifest;
    expect(manifest.metadata.captureMode).toBe("errors");
    expect(manifest.response.status).toBe(500);
  });

  it("full mode persists 200 and stamps captureMode full", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "full",
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(1);
    const first = [...storage.manifests.entries()][0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, bytes] = first;
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as InteractionManifest;
    expect(manifest.metadata.captureMode).toBe("full");
  });

  it("errors mode persists when the response ends with a terminal host error", async () => {
    const storage = memoryStorage();
    handle = attachRecorder({
      storage,
      captureMode: "errors",
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.destroy(new Error("socket boom"));
    });
    await listen(server);
    const base = addressOf(server);

    await expect(fetch(`${base}/`)).rejects.toThrow();
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(1);
    const first = [...storage.manifests.entries()][0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, bytes] = first;
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as InteractionManifest;
    expect(manifest.metadata.captureMode).toBe("errors");
  });

  it("does not treat 4xx as an errors-mode persist trigger", async () => {
    const storage = memoryStorage();
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage,
      captureMode: "errors",
      onEvent: (e) => events.push(e),
    });

    server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/missing`)).status).toBe(404);
    await handle.drain(2_000);

    expect(storage.manifests.size).toBe(0);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_dropped" &&
          e.reason === "capture_mode_filter",
      ),
    ).toBe(true);
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
