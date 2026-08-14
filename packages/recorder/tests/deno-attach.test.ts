import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest } from "@epok/core";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import {
  attachDenoRecorder,
  type DenoRecorderHandle,
  type RecorderWideEvent,
} from "../src/deno.js";

describe("attachDenoRecorder", () => {
  let handle: DenoRecorderHandle | undefined;
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

    handle = attachDenoRecorder({
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
    expect(manifest.metadata.runtime.name).toBe("deno");
  });

  it("does not surface recorder failures as host handler failures", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];

    handle = attachDenoRecorder({
      storage,
      captureMode: "full",
      hooks: {
        onInbound() {
          throw new Error("hook boom");
        },
      },
      onEvent: (event) => {
        events.push(event);
        throw new Error("onEvent boom");
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
