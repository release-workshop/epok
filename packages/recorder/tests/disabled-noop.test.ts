import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";
import { unusedStorage } from "./helpers.js";

describe("attachRecorder enabled=false structural no-op", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await handle?.drain(1_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
  });

  it("keeps interception plumbing but never captures, persists, or drops", async () => {
    const events: RecorderWideEvent[] = [];
    let depHits = 0;

    handle = attachRecorder({
      storage: unusedStorage(),
      enabled: false,
      onEvent: (e) => {
        events.push(e);
      },
    });

    server = createServer(async (_req, res) => {
      const upstream = await fetch("http://127.0.0.1:9/");
      void upstream;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    // Replace the recorder-wrapped fetch so dep calls stay inside the intercept chain.
    const wrappedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("http://127.0.0.1:9")) {
        depHits += 1;
        return new Response("dep", { status: 200 });
      }
      return wrappedFetch(input, init);
    };

    try {
      await listen(server);
      const base = addressOf(server);
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(depHits).toBe(1);

      await handle.drain(500);
      const stats = handle.pressureStats();
      expect(stats.observed).toBe(0);
      expect(stats.dropped).toBe(0);
      expect(stats.queueDepth).toBe(0);
      expect(events).toHaveLength(0);
    } finally {
      globalThis.fetch = wrappedFetch;
    }
  });
});

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
