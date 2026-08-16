import { describe, expect, it, afterEach } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import {
  createAttachRuntime,
  type AttachRuntime,
} from "../src/attach-runtime.js";
import type { InboundSnapshot } from "../src/capture.js";
import type { RecorderWideEvent } from "../src/events.js";

const inbound: InboundSnapshot = {
  protocol: "HTTP/1.1",
  method: "GET",
  url: "http://127.0.0.1/pay",
  headers: [{ name: "host", value: "127.0.0.1" }],
  contentType: null,
};

function syncDefer(work: () => void): void {
  work();
}

describe("createAttachRuntime begin", () => {
  let runtime: AttachRuntime | undefined;

  afterEach(() => {
    runtime?.detach();
    runtime = undefined;
  });

  it("returns disabled without counting an observed Interaction", () => {
    const events: RecorderWideEvent[] = [];
    runtime = createAttachRuntime({
      storage: createMemoryStorageProvider(),
      enabled: false,
      deferJob: syncDefer,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const begun = runtime.begin();
    expect(begun.kind).toBe("disabled");
    expect(begun.ctx.capture).toBeNull();
    expect(runtime.stats().observed).toBe(0);
  });

  it("returns capture with an acquired buffer and counts observed", () => {
    runtime = createAttachRuntime({
      storage: createMemoryStorageProvider(),
      deferJob: syncDefer,
    });

    const begun = runtime.begin();
    expect(begun.kind).toBe("capture");
    if (begun.kind !== "capture") return;
    expect(begun.buf.interactionId).toBe(begun.ctx.interactionId);
    expect(runtime.stats().observed).toBe(1);
    expect(runtime.stats().activeContexts).toBe(1);
  });

  it("returns shed when the active-context budget is exhausted", () => {
    runtime = createAttachRuntime({
      storage: createMemoryStorageProvider(),
      pressure: { maxActiveContexts: 1 },
      deferJob: syncDefer,
    });

    expect(runtime.begin().kind).toBe("capture");
    const shed = runtime.begin();
    expect(shed.kind).toBe("shed");
    if (shed.kind !== "shed") return;
    expect(shed.reason).toBe("active_contexts_budget");
    expect(runtime.stats().dropped).toBe(1);
  });
});

describe("createAttachRuntime observe", () => {
  let runtime: AttachRuntime | undefined;

  afterEach(() => {
    runtime?.detach();
    runtime = undefined;
  });

  it("bound observeInbound invokes hooks fail-open", () => {
    const seen: string[] = [];
    runtime = createAttachRuntime({
      storage: createMemoryStorageProvider(),
      deferJob: syncDefer,
      hooks: {
        onInbound(request) {
          seen.push(request.url);
          throw new Error("hook boom");
        },
      },
    });

    const begun = runtime.begin();
    const active = runtime;
    expect(() => {
      active.observeInbound(begun.ctx, new Request("http://127.0.0.1/hook"));
    }).not.toThrow();
    expect(seen).toEqual(["http://127.0.0.1/hook"]);
  });

  it("detach restores global fetch", () => {
    const originalFetch = globalThis.fetch;
    runtime = createAttachRuntime({
      storage: createMemoryStorageProvider(),
      deferJob: syncDefer,
    });
    expect(globalThis.fetch).not.toBe(originalFetch);
    runtime.detach();
    expect(globalThis.fetch).toBe(originalFetch);
    runtime = undefined;
  });
});

describe("createAttachRuntime settle", () => {
  let runtime: AttachRuntime | undefined;

  afterEach(() => {
    runtime?.detach();
    runtime = undefined;
  });

  it("persists through the narrow helper and drain clears work", async () => {
    const storage = createMemoryStorageProvider();
    runtime = createAttachRuntime({
      storage,
      captureMode: "full",
      deferJob: syncDefer,
    });

    const begun = runtime.begin();
    expect(begun.kind).toBe("capture");
    if (begun.kind !== "capture") return;

    begun.buf.statusCode = 200;
    begun.buf.inboundTerminalObserved = true;

    runtime.trackSettle(
      runtime.settle({
        interactionId: begun.ctx.interactionId,
        buf: begun.buf,
        inbound,
      }),
    );

    await runtime.drain(2_000);

    const bytes = await storage.getManifest(begun.ctx.interactionId);
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      inbound: { url: string };
    };
    expect(manifest.inbound.url).toBe("http://127.0.0.1/pay");
    expect(runtime.stats().persisted).toBe(1);
    expect(runtime.stats().activeContexts).toBe(0);
  });

  it("uses injected deferJob to pump the persist queue", async () => {
    const storage = createMemoryStorageProvider();
    let deferred = 0;
    runtime = createAttachRuntime({
      storage,
      captureMode: "full",
      deferJob: (work) => {
        deferred += 1;
        queueMicrotask(work);
      },
    });

    const begun = runtime.begin();
    expect(begun.kind).toBe("capture");
    if (begun.kind !== "capture") return;

    begun.buf.statusCode = 200;
    begun.buf.inboundTerminalObserved = true;

    runtime.trackSettle(
      runtime.settle({
        interactionId: begun.ctx.interactionId,
        buf: begun.buf,
        inbound,
      }),
    );

    await runtime.drain(2_000);
    expect(deferred).toBeGreaterThan(0);
    expect(runtime.stats().persisted).toBe(1);
  });
});
