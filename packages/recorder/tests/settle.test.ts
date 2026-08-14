import { describe, expect, it } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import {
  beginBodyRead,
  createCaptureBuffers,
  endBodyRead,
  markDropped,
} from "../src/capture.js";
import { PressureController } from "../src/pressure.js";
import { BoundedAsyncQueue } from "../src/queue.js";
import { createSettleTracker, settleInteraction } from "../src/settle.js";
import type { InboundSnapshot } from "../src/capture.js";
import type { RecorderWideEvent } from "../src/events.js";

const inbound: InboundSnapshot = {
  protocol: "HTTP/1.1",
  method: "GET",
  url: "http://127.0.0.1/pay",
  headers: [{ name: "host", value: "127.0.0.1" }],
  contentType: null,
};

function setup(limits?: { maxQueueDepth?: number }) {
  const events: RecorderWideEvent[] = [];
  const emit: import("../src/observe.js").EmitWideEvent = (event) => {
    events.push(event);
  };
  const pressure = new PressureController(
    {
      maxQueueDepth: limits?.maxQueueDepth ?? 128,
      maxConcurrency: 2,
      maxActiveContexts: 256,
      maxBufferedBytes: 16 * 1024 * 1024,
      bodyElision: true,
    },
    emit,
  );
  const queue = new BoundedAsyncQueue(pressure);
  const storage = createMemoryStorageProvider();
  const buf = createCaptureBuffers();
  buf.statusCode = 200;
  buf.inboundTerminalObserved = true;
  expect(pressure.tryAcquireContext()).toBe(true);
  return { events, emit, pressure, queue, storage, buf };
}

describe("settleInteraction", () => {
  it("copies inbound snapshot at entry and persists after the queue job", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    const interactionId = "01900000-0000-7000-8000-000000000001";

    await settleInteraction({
      interactionId,
      buf,
      inbound: { ...inbound, method: "POST" },
      captureMode: "full",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        work();
      },
    });

    expect(buf.inboundSnapshot?.method).toBe("POST");
    expect(buf.frozen).toBe(true);

    await queue.drain(2_000);

    const bytes = await storage.getManifest(interactionId);
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      inbound: { method: string; url: string };
    };
    expect(manifest.inbound.method).toBe("POST");
    expect(manifest.inbound.url).toBe("http://127.0.0.1/pay");
    expect(pressure.finalized).toBe(1);
    expect(pressure.persisted).toBe(1);
    expect(pressure.activeContexts).toBe(0);
  });

  it("filters errors-mode 200 off the persist queue via deferOffHotPath", async () => {
    const { events, emit, pressure, queue, storage, buf } = setup();
    let deferred = 0;

    await settleInteraction({
      interactionId: "id-filter",
      buf,
      inbound,
      captureMode: "errors",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        deferred += 1;
        work();
      },
    });

    expect(deferred).toBe(1);
    expect(pressure.filtered).toBe(1);
    expect(pressure.persisted).toBe(0);
    expect(pressure.activeContexts).toBe(0);
    expect(
      events.some(
        (e) =>
          e.type === "interaction_dropped" &&
          e.reason === "capture_mode_filter",
      ),
    ).toBe(true);
    await expect(storage.getManifest("id-filter")).rejects.toThrow();
  });

  it("does not resolve until deferred capture-mode release runs", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settling = settleInteraction({
      interactionId: "id-filter-wait",
      buf,
      inbound,
      captureMode: "errors",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        void held.then(work);
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(pressure.activeContexts).toBe(1);
    expect(pressure.filtered).toBe(0);

    release();
    await settling;
    expect(pressure.activeContexts).toBe(0);
    expect(pressure.filtered).toBe(1);
  });

  it("persists errors-mode when status is >= 500", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    buf.statusCode = 503;

    await settleInteraction({
      interactionId: "id-500",
      buf,
      inbound,
      captureMode: "errors",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        work();
      },
    });
    await queue.drain(2_000);

    expect(pressure.persisted).toBe(1);
    await storage.getManifest("id-500");
  });

  it("releases a dropped capture without enqueueing", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    markDropped(buf, "buffered_bytes_budget");

    await settleInteraction({
      interactionId: "id-drop",
      buf,
      inbound,
      captureMode: "full",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        work();
      },
    });

    expect(pressure.dropped).toBe(1);
    expect(pressure.persisted).toBe(0);
    expect(pressure.activeContexts).toBe(0);
    await expect(storage.getManifest("id-drop")).rejects.toThrow();
  });

  it("records queue_full when the persist queue is at capacity", async () => {
    const { emit, pressure, queue, storage, buf } = setup({
      maxQueueDepth: 0,
    });

    await settleInteraction({
      interactionId: "id-full",
      buf,
      inbound,
      captureMode: "full",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        work();
      },
    });

    expect(pressure.dropped).toBe(1);
    expect(pressure.activeContexts).toBe(0);
  });

  it("applies refreshTerminal after body wait before capture-mode", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    buf.statusCode = undefined;
    buf.inboundTerminalObserved = false;

    await settleInteraction({
      interactionId: "id-refresh",
      buf,
      inbound,
      captureMode: "errors",
      emit,
      storage,
      pressure,
      queue,
      deferOffHotPath: (work) => {
        work();
      },
      refreshTerminal: () => {
        buf.statusCode = 500;
        buf.inboundTerminalObserved = true;
      },
    });
    await queue.drain(2_000);

    expect(pressure.persisted).toBe(1);
  });
});

describe("createSettleTracker", () => {
  it("drain waits for in-flight settle body reads", async () => {
    const { emit, pressure, queue, storage, buf } = setup();
    beginBodyRead(buf);
    const settles = createSettleTracker();

    settles.track(
      settleInteraction({
        interactionId: "id-wait",
        buf,
        inbound,
        captureMode: "full",
        emit,
        storage,
        pressure,
        queue,
        deferOffHotPath: (work) => {
          work();
        },
      }),
    );

    let drainedEarly = false;
    void settles.drain(80, queue).then(() => {
      drainedEarly = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(drainedEarly).toBe(false);

    endBodyRead(buf);
    await settles.drain(2_000, queue);
    expect(pressure.persisted).toBe(1);
  });
});
