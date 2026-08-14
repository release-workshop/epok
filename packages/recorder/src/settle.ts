import type { StorageProvider, RuntimeIdentity } from "@epok/core";
import type { CaptureMode } from "./capture-mode.js";
import { shouldPersistInteraction } from "./capture-mode.js";
import {
  buildObservedCapture,
  freezeCapture,
  releaseCaptureBytes,
  waitForBodyReads,
  type CaptureBuffers,
  type InboundSnapshot,
} from "./capture.js";
import { finalizeObservation } from "./finalize.js";
import type { EmitWideEvent } from "./observe.js";
import { persistFinalizedInteraction } from "./persist.js";
import type { PressureController } from "./pressure.js";
import type { BoundedAsyncQueue } from "./queue.js";

/** Schedule capture-mode pressure release off the host terminal callback. */
export type DeferOffHotPath = (work: () => void) => void;

export interface SettleInteractionInput {
  interactionId: string;
  buf: CaptureBuffers;
  inbound: InboundSnapshot;
  captureMode: CaptureMode;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  queue: BoundedAsyncQueue;
  deferOffHotPath: DeferOffHotPath;
  /** Applied after body wait (e.g. Workers handler throw). */
  terminalHostError?: boolean;
  /** Node adapter re-reads ServerResponse after body wait. */
  refreshTerminal?: () => void;
  /** Stamped on the Interaction metadata (Fetch adapters). */
  runtime?: RuntimeIdentity;
}

/**
 * Freeze, wait for body reads, capture-mode filter, enqueue finalize/persist,
 * and release pressure. Adapters supply the inbound snapshot and terminal flags.
 */
export async function settleInteraction(
  input: SettleInteractionInput,
): Promise<void> {
  const {
    interactionId,
    buf,
    inbound,
    captureMode,
    emit,
    storage,
    pressure,
    queue,
    deferOffHotPath,
  } = input;

  buf.inboundSnapshot = inbound;
  if (input.runtime !== undefined) {
    buf.runtime = input.runtime;
  }

  try {
    freezeCapture(buf);
    await waitForBodyReads(buf);

    if (buf.dropped) {
      if (buf.dropReason === "buffered_bytes_budget") {
        pressure.recordDrop("buffered_bytes_budget", interactionId);
      }
      releaseCaptureBytes(pressure, buf);
      pressure.releaseContext();
      return;
    }

    if (input.terminalHostError) {
      buf.terminalHostError = true;
    }
    input.refreshTerminal?.();

    if (
      !shouldPersistInteraction(captureMode, {
        ...(buf.statusCode !== undefined ? { status: buf.statusCode } : {}),
        terminalHostError: buf.terminalHostError,
      })
    ) {
      await scheduleCaptureModeDrop({
        interactionId,
        reservedBytes: buf.reservedBytes,
        emit,
        pressure,
        deferOffHotPath,
      });
      buf.reservedBytes = 0;
      return;
    }

    const reservedForJob = buf.reservedBytes;
    buf.reservedBytes = 0;

    const enqueued = queue.tryEnqueue(() =>
      runFinalizePersist({
        interactionId,
        buf,
        captureMode,
        emit,
        storage,
        pressure,
        reservedForJob,
      }),
    );

    if (!enqueued) {
      pressure.releaseBytes(reservedForJob);
      pressure.releaseContext();
      pressure.recordDrop("queue_full", interactionId);
    }
  } catch {
    try {
      releaseCaptureBytes(pressure, buf);
      pressure.releaseContext();
    } catch {
      // Fail-open.
    }
  }
}

async function runFinalizePersist(input: {
  interactionId: string;
  buf: CaptureBuffers;
  captureMode: CaptureMode;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  reservedForJob: number;
}): Promise<void> {
  const { interactionId, buf, captureMode, emit, storage, pressure } = input;
  try {
    const capture = buildObservedCapture(interactionId, buf, captureMode);
    if (capture === null) {
      return;
    }
    const finalized = finalizeObservation(capture, {
      ...(emit ? { onEvent: emit } : {}),
      onFinalized: () => {
        pressure.recordFinalized();
      },
    });
    if (finalized === null) {
      return;
    }
    await persistFinalizedInteraction(storage, finalized, emit, () => {
      pressure.recordPersisted();
    });
  } finally {
    pressure.releaseBytes(input.reservedForJob);
    pressure.releaseContext();
  }
}

function scheduleCaptureModeDrop(input: {
  interactionId: string;
  reservedBytes: number;
  emit: EmitWideEvent | undefined;
  pressure: PressureController;
  deferOffHotPath: DeferOffHotPath;
}): Promise<void> {
  const { interactionId, reservedBytes, emit, pressure, deferOffHotPath } =
    input;
  return new Promise((resolve) => {
    deferOffHotPath(() => {
      try {
        pressure.recordFiltered();
        emit?.({
          type: "interaction_dropped",
          reason: "capture_mode_filter",
          interactionId,
        });
      } finally {
        pressure.releaseBytes(reservedBytes);
        pressure.releaseContext();
        resolve();
      }
    });
  });
}

/** Track in-flight settle promises so drain waits for freeze/wait as well as persist. */
export function createSettleTracker(): {
  track(promise: Promise<void>): void;
  drain(
    timeoutMs: number,
    queue: { depth: number; drain: (ms: number) => Promise<void> },
  ): Promise<void>;
} {
  const pending = new Set<Promise<void>>();

  return {
    track(promise: Promise<void>): void {
      pending.add(promise);
      void promise.finally(() => {
        pending.delete(promise);
      });
    },
    async drain(timeoutMs, queue) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pending.size === 0 && queue.depth === 0) {
          return;
        }
        await Promise.allSettled([...pending]);
        await queue.drain(Math.max(0, deadline - Date.now()));
        if (pending.size === 0 && queue.depth === 0) {
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}
