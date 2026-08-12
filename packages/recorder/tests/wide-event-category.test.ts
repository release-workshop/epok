import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "../src/index.js";
import { createWideEventEmit } from "../src/wide-event-emit.js";
import { unusedStorage } from "./helpers.js";

describe("createWideEventEmit", () => {
  it("is undefined without a subscriber", () => {
    expect(createWideEventEmit(undefined)).toBeUndefined();
  });

  it("skips constructing filtered chatter under ops via includes()", () => {
    const ops = createWideEventEmit(() => {
      /* unused */
    }, "ops");
    expect(ops?.includes("observed")).toBe(false);
    expect(ops?.includes("context_missing")).toBe(false);
    expect(ops?.includes("interaction_dropped")).toBe(true);
    expect(ops?.includes("body_elided")).toBe(true);

    const all = createWideEventEmit(() => {
      /* unused */
    }, "all");
    expect(all?.includes("observed")).toBe(true);
    expect(all?.includes("context_missing")).toBe(true);
  });

  it("does not deliver filtered events to onEvent", () => {
    const delivered: RecorderWideEvent["type"][] = [];
    const emit = createWideEventEmit((event) => {
      delivered.push(event.type);
    }, "ops");

    emit?.({
      type: "observed",
      phase: "inbound",
      interactionId: "x",
      method: "GET",
      url: "http://127.0.0.1/",
    });
    emit?.({
      type: "interaction_dropped",
      reason: "queue_full",
      interactionId: "x",
    });

    expect(delivered).toEqual(["interaction_dropped"]);
  });
});

describe("wide-event category + subscriber gate", () => {
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

  it("defaults onEvent to ops category (no observed / context_missing chatter)", async () => {
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

    server = createServer(async (_req, res) => {
      await fetch(`${depBase}/dep`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await fetch(`${depBase}/outside`);
    await handle.drain(2_000);

    expect(events.some((e) => e.type === "observed")).toBe(false);
    expect(events.some((e) => e.type === "context_missing")).toBe(false);
    // Process-wide attach also observes the dependency server's inbounds.
    expect(handle.stats().observed).toBeGreaterThan(0);
  });

  it("delivers observed and context_missing when onEventCategory is all", async () => {
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage: unusedStorage(),
      onEventCategory: "all",
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

    server = createServer(async (_req, res) => {
      await fetch(`${depBase}/dep`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await fetch(`${depBase}/outside`);
    await handle.drain(2_000);

    expect(
      events.some((e) => e.type === "observed" && e.phase === "inbound"),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "context_missing" &&
          e.reason === "no_request_context" &&
          e.url.includes("/outside"),
      ),
    ).toBe(true);
  });

  it("still delivers ops events under the default category", async () => {
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage: {
        durability: "best-effort",
        putManifest: async () => {
          /* accept */
        },
        getManifest: async () => {
          throw new Error("unused");
        },
        putObject: async () => ({ created: true }),
        getObject: async () => {
          throw new Error("unused");
        },
        hasObject: async () => false,
      },
      captureMode: "full",
      onEvent: (event) => {
        events.push(event);
      },
    });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await listen(server);
    const base = addressOf(server);

    expect((await fetch(`${base}/`)).status).toBe(200);
    await handle.drain(2_000);

    expect(events.some((e) => e.type === "interaction_finalized")).toBe(true);
    expect(events.some((e) => e.type === "interaction_persisted")).toBe(true);
    expect(events.some((e) => e.type === "observed")).toBe(false);
  });

  it("updates counters without onEvent and keeps the host fail-open when the subscriber throws", async () => {
    const events: RecorderWideEvent[] = [];
    handle = attachRecorder({
      storage: {
        durability: "best-effort",
        putManifest: async () => {
          /* accept */
        },
        getManifest: async () => {
          throw new Error("unused");
        },
        putObject: async () => ({ created: true }),
        getObject: async () => {
          throw new Error("unused");
        },
        hasObject: async () => false,
      },
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

    const stats = handle.stats();
    expect(stats.observed).toBe(1);
    expect(stats.finalized).toBe(1);
    expect(stats.persisted).toBe(1);
    expect(events).toHaveLength(0);

    handle.detach();
    handle = attachRecorder({
      storage: unusedStorage(),
      onEventCategory: "all",
      hooks: {
        onInbound() {
          throw new Error("inbound hook boom");
        },
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "observed") {
          throw new Error("onEvent boom");
        }
      },
    });

    server.close();
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("host-ok");
    });
    await listen(server);
    const base2 = addressOf(server);

    const response = await fetch(`${base2}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("host-ok");
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
