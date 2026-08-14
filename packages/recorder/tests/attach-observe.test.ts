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

  afterEach(async () => {
    await handle?.drain(2_000);
    handle?.detach();
    handle = undefined;
    server?.close();
    server = undefined;
    dependencyServer?.close();
    dependencyServer = undefined;
  });

  it("pairs inbound request with its outbound dependency under concurrency", async () => {
    const pairs: Array<{ inboundId?: string; dependencyId?: string }> = [];
    const byInteraction = new Map<
      string,
      { inboundId?: string; dependencyId?: string }
    >();

    handle = attachRecorder({
      storage: unusedStorage(),
      hooks: {
        onInbound(request) {
          const id = request.headers.get("x-request-id");
          if (id === null) return;
          const row = byInteraction.get(id) ?? {};
          row.inboundId = id;
          byInteraction.set(id, row);
        },
        onDependency(request) {
          const dependencyId = new URL(request.url).searchParams.get("id");
          if (dependencyId === null) return;
          const row = byInteraction.get(dependencyId) ?? {};
          row.dependencyId = dependencyId;
          byInteraction.set(dependencyId, row);
        },
      },
    });

    dependencyServer = createServer((_req, res) => {
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

    for (const id of ids) {
      pairs.push(byInteraction.get(id) ?? {});
    }
    expect(pairs).toHaveLength(20);
    for (const row of pairs) {
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
        throw new Error("onEvent boom");
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
