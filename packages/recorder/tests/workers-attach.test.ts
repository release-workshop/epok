import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest } from "@epok/core";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import {
  attachWorkersRecorder,
  type WorkersRecorderHandle,
  type RecorderWideEvent,
} from "../src/workers.js";

describe("attachWorkersRecorder", () => {
  let handle: WorkersRecorderHandle | undefined;
  let dependencyServer: Server | undefined;

  afterEach(async () => {
    await handle?.drain();
    handle?.detach();
    handle = undefined;
    dependencyServer?.close();
    dependencyServer = undefined;
  });

  it("records an Interaction with inbound and dependency via Fetch handler", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];

    handle = attachWorkersRecorder({
      storage,
      captureMode: "full",
      onEvent: (event) => {
        events.push(event);
      },
    });

    dependencyServer = createServer((req, res) => {
      const id = new URL(req.url ?? "/", "http://localhost").searchParams.get(
        "id",
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quote: Number(id?.replace(/\D/g, "") ?? 0) }));
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    const appHandler = handle.wrapHandler(async (request: Request) => {
      const id = request.headers.get("x-request-id") ?? "0";
      const dep = await fetch(`${depBase}/quote?id=${encodeURIComponent(id)}`);
      const payload = (await dep.json()) as { quote: number };
      return Response.json({ requestId: id, total: payload.quote });
    });

    const response = await appHandler(
      new Request("http://127.0.0.1/total", {
        headers: { "x-request-id": "7" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requestId: "7", total: 7 });

    await handle.drain(2_000);

    const persisted = events.filter((e) => e.type === "interaction_persisted");
    expect(persisted).toHaveLength(1);

    const interactionId = persisted[0]?.interactionId;
    expect(interactionId).toBeDefined();
    const manifestBytes = await storage.getManifest(interactionId as string);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as InteractionManifest;

    expect(manifest.inbound.method).toBe("GET");
    expect(manifest.inbound.url).toBe("http://127.0.0.1/total");
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.dependencies[0]?.request.url).toContain("/quote?id=7");
    expect(manifest.metadata.runtime.name).toBe("cloudflare-workers");
  });

  it("does not surface recorder failures as host handler failures", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];

    handle = attachWorkersRecorder({
      storage,
      captureMode: "full",
      hooks: {
        onInbound() {
          throw new Error("hook boom");
        },
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "observed") {
          throw new Error("onEvent boom");
        }
      },
    });

    const appHandler = handle.wrapHandler(async () =>
      Response.json({ ok: true }),
    );
    const response = await appHandler(new Request("http://127.0.0.1/"));
    expect(response.status).toBe(200);
    expect(
      events.some(
        (e) =>
          e.type === "observation_dropped" && e.reason === "observer_threw",
      ),
    ).toBe(true);
  });

  it("elides Fetch-handler bodies under byte-budget pressure without failing the host", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];
    handle = attachWorkersRecorder({
      storage,
      captureMode: "full",
      pressure: {
        maxQueueDepth: 32,
        maxConcurrency: 2,
        maxActiveContexts: 32,
        maxBufferedBytes: 16,
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    const payload = "w".repeat(64);
    const appHandler = handle.wrapHandler(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const response = await appHandler(new Request("http://127.0.0.1/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);

    await handle.drain(2_000);

    expect(handle.stats().dropped).toBe(0);
    expect(events.some((e) => e.type === "body_elided")).toBe(true);
    const persisted = events.filter((e) => e.type === "interaction_persisted");
    expect(persisted).toHaveLength(1);
    const interactionId = persisted[0]?.interactionId;
    expect(interactionId).toBeDefined();
    if (interactionId === undefined) return;
    const manifestBytes = await storage.getManifest(interactionId);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as InteractionManifest;
    expect(manifest.response?.body.cas.size).toBe(0);
  });

  it("persists handler throw as response null with an unterminated in-flight fetch", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];
    handle = attachWorkersRecorder({
      storage,
      captureMode: "errors",
      onEvent: (event) => {
        events.push(event);
      },
    });

    dependencyServer = createServer((_req, _res) => {
      // Hang so the outbound is still open when the handler throws.
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    const appHandler = handle.wrapHandler(async () => {
      void fetch(`${depBase}/slow`).catch(() => undefined);
      throw new Error("handler boom");
    });

    await expect(
      appHandler(new Request("http://127.0.0.1/boom")),
    ).rejects.toThrow("handler boom");
    await handle.drain(2_000);

    const persisted = events.filter((e) => e.type === "interaction_persisted");
    expect(persisted).toHaveLength(1);
    const interactionId = persisted[0]?.interactionId;
    expect(interactionId).toBeDefined();
    if (interactionId === undefined) return;
    const manifest = JSON.parse(
      new TextDecoder().decode(await storage.getManifest(interactionId)),
    ) as InteractionManifest;
    expect(manifest.response).toBeNull();
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.dependencies[0]?.response).toBeNull();
    expect(manifest.dependencies[0]?.error).toBeUndefined();
    expect(manifest.dependencies[0]?.request.url).toContain("/slow");
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
