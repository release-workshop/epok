import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { runReplay } from "@epok/replay";
import {
  attachBunRecorder,
  type BunRecorderHandle,
  type RecorderWideEvent,
} from "../src/bun.js";

async function handleRequest(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? "anon";
  const depBase = request.headers.get("x-epok-dependency-base");
  if (!depBase) {
    throw new Error("missing x-epok-dependency-base header");
  }
  const url = `${depBase}/quote?id=${encodeURIComponent(requestId)}`;
  const depRes = await fetch(url);
  const payload = (await depRes.json()) as { quote: number };
  return Response.json({
    requestId,
    total: payload.quote,
  });
}

describe("Bun golden offline replay", () => {
  let handle: BunRecorderHandle | undefined;
  let dependencyServer: Server | undefined;

  afterEach(async () => {
    await handle?.drain();
    handle?.detach();
    handle = undefined;
    dependencyServer?.close();
    dependencyServer = undefined;
  });

  it("records via Bun attach then replays offline on Node without network hits", async () => {
    const storage = createMemoryStorageProvider();
    const events: RecorderWideEvent[] = [];
    handle = attachBunRecorder({
      storage,
      captureMode: "full",
      onEvent: (event) => {
        events.push(event);
      },
    });

    dependencyServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quote: 42 }));
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    const appHandler = handle.wrapHandler(handleRequest);
    const recordResponse = await appHandler(
      new Request("http://127.0.0.1/total", {
        headers: {
          "x-request-id": "demo-1",
          "x-epok-dependency-base": depBase,
          accept: "application/json",
        },
      }),
    );
    expect(recordResponse.status).toBe(200);
    expect(await recordResponse.json()).toEqual({
      requestId: "demo-1",
      total: 42,
    });

    await handle.drain(2_000);

    const persisted = events.find((e) => e.type === "interaction_persisted");
    expect(persisted?.interactionId).toBeDefined();
    const interactionId = persisted?.interactionId as string;

    let networkHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      networkHits += 1;
      return originalFetch(...args);
    };

    try {
      const result = await runReplay({
        storage,
        interactionId,
        handler: handleRequest,
      });

      expect(result.ok).toBe(true);
      expect(networkHits).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
