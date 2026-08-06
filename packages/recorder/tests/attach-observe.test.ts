import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";
import { unusedStorage } from "./helpers.js";

describe("attachRecorder observe-only", () => {
  let handle: RecorderHandle | undefined;
  let server: Server | undefined;
  let dependencyServer: Server | undefined;

  afterEach(() => {
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
    dependencyServer?.close();
    dependencyServer = undefined;
  });

  it("pairs inbound request with its outbound dependency under concurrency", async () => {
    const events: RecorderWideEvent[] = [];

    handle = attachRecorder({
      storage: unusedStorage(),
      onEvent: (event) => {
        events.push(event);
      },
    });

    dependencyServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("dep-ok");
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer(async (req, res) => {
      const id = String(req.headers["x-request-id"] ?? "");
      await fetch(`${depBase}/dep?id=${encodeURIComponent(id)}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    const ids = Array.from({ length: 20 }, (_, i) => `req-${i}`);
    await Promise.all(
      ids.map((id) =>
        fetch(`${base}/`, { headers: { "x-request-id": id } }).then((r) =>
          r.text(),
        ),
      ),
    );

    const byInteraction = new Map<
      string,
      { inboundId?: string; dependencyId?: string }
    >();

    for (const event of events) {
      if (event.type !== "observed") continue;
      const row = byInteraction.get(event.interactionId) ?? {};
      if (event.phase === "inbound") {
        row.inboundId = event.requestHeaders?.["x-request-id"];
      } else if (event.phase === "dependency") {
        row.dependencyId =
          new URL(event.url).searchParams.get("id") ?? undefined;
      }
      byInteraction.set(event.interactionId, row);
    }

    // Dependency server inbounds are also observed under process-wide attach;
    // only app interactions carry both x-request-id and an outbound dependency.
    const appPairs = [...byInteraction.values()].filter(
      (row) => row.inboundId !== undefined && row.dependencyId !== undefined,
    );
    expect(appPairs).toHaveLength(20);
    for (const row of appPairs) {
      expect(row.dependencyId).toBe(row.inboundId);
    }
  });

  it("does not surface recorder hook failures as host request failures", async () => {
    const events: RecorderWideEvent[] = [];

    handle = attachRecorder({
      storage: unusedStorage(),
      hooks: {
        onInbound() {
          throw new Error("inbound hook boom");
        },
        onDependency() {
          throw new Error("dependency hook boom");
        },
        onResponse() {
          throw new Error("response hook boom");
        },
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "observed") {
          throw new Error("onEvent boom");
        }
      },
    });

    dependencyServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("dep");
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    server = createServer(async (_req, res) => {
      await fetch(`${depBase}/dep`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("host-ok");
    });
    await listen(server);
    const base = addressOf(server);

    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("host-ok");
    expect(
      events.some(
        (e) =>
          e.type === "observation_dropped" && e.reason === "observer_threw",
      ),
    ).toBe(true);
  });

  it("emits context_missing when fetch runs outside request context", async () => {
    const events: RecorderWideEvent[] = [];

    handle = attachRecorder({
      storage: unusedStorage(),
      onEvent: (event) => {
        events.push(event);
      },
    });

    dependencyServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("dep");
    });
    await listen(dependencyServer);
    const depBase = addressOf(dependencyServer);

    await fetch(`${depBase}/outside`);

    expect(
      events.some(
        (e) =>
          e.type === "context_missing" &&
          e.reason === "no_request_context" &&
          e.url.includes("/outside"),
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
