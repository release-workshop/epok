import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import type { CaptureMode } from "./capture-mode.js";
import { shouldPersistInteraction } from "./capture-mode.js";
import {
  buildObservedCapture,
  expectsInboundBody,
  installInboundBodyCapture,
  installResponseCapture,
  releaseCaptureBytes,
  skipOrElideBodies,
  waitForBodyReads,
  type CaptureBuffers,
} from "./capture.js";
import { createCaptureContext, requestContext } from "./context.js";
import { finalizeObservation } from "./finalize.js";
import type { EmitWideEvent } from "./observe.js";
import { observeInbound, observeResponse } from "./observe.js";
import { persistFinalizedInteraction } from "./persist.js";
import type { PressureController } from "./pressure.js";
import type { BoundedAsyncQueue } from "./queue.js";

type ServerEmit = typeof http.Server.prototype.emit;

export interface InboundAttachDeps {
  /** When false, wrappers + ALS stay active but capture/persist are skipped. */
  enabled: boolean;
  captureMode: CaptureMode;
  hooks: RecorderObservationHooks | undefined;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  queue: BoundedAsyncQueue;
}

/**
 * Patch `http.Server` so each inbound request runs inside AsyncLocalStorage,
 * collects a capture buffer, and enqueues sanitize/finalize/persist off-path.
 * Returns a restore function.
 */
export function installInboundAttach(deps: InboundAttachDeps): () => void {
  const { enabled, captureMode, hooks, emit, storage, pressure, queue } = deps;
  const originalEmit: ServerEmit = Reflect.get(http.Server.prototype, "emit");

  function patchedEmit(
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event !== "request" || args.length < 2) {
      return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    }

    const req = args[0] as IncomingMessage;
    const res = args[1] as ServerResponse;

    if (!enabled) {
      const ctx = createCaptureContext(false);
      return requestContext.run(
        ctx,
        () => Reflect.apply(originalEmit, this, [event, ...args]) as boolean,
      );
    }

    pressure.recordObserved();
    const acquired = !pressure.sheddingActive && pressure.tryAcquireContext();
    const ctx = createCaptureContext(acquired);

    if (!acquired) {
      const reason = pressure.sheddingActive
        ? "queue_full"
        : "active_contexts_budget";
      pressure.recordDrop(reason, ctx.interactionId);
      return requestContext.run(ctx, () => {
        observeInbound(ctx, req, hooks, emit);
        res.once("finish", () => {
          observeResponse(ctx, req, res, hooks, emit);
        });
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      });
    }

    return requestContext.run(ctx, () => {
      const buf = ctx.capture;
      if (!buf) {
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      }
      try {
        if (expectsInboundBody(req)) {
          if (!skipOrElideBodies(pressure, buf)) {
            installInboundBodyCapture(req, buf, pressure);
          }
        }
        installResponseCapture(res, buf, pressure);
      } catch {
        // Fail-open.
      }

      observeInbound(ctx, req, hooks, emit);

      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        void settleAndEnqueue({
          interactionId: ctx.interactionId,
          req,
          res,
          buf,
          captureMode,
          emit,
          storage,
          pressure,
          queue,
        });
      };
      res.once("finish", () => {
        observeResponse(ctx, req, res, hooks, emit);
        settle();
      });
      res.once("close", settle);

      try {
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      } catch (err) {
        buf.terminalHostError = true;
        settle();
        throw err;
      }
    });
  }

  http.Server.prototype.emit = patchedEmit as ServerEmit;
  return () => {
    http.Server.prototype.emit = originalEmit;
  };
}

async function settleAndEnqueue(input: {
  interactionId: string;
  req: IncomingMessage;
  res: ServerResponse;
  buf: CaptureBuffers;
  captureMode: CaptureMode;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  queue: BoundedAsyncQueue;
}): Promise<void> {
  const {
    interactionId,
    req,
    res,
    buf,
    captureMode,
    emit,
    storage,
    pressure,
    queue,
  } = input;
  try {
    await waitForBodyReads(buf);

    if (buf.dropped) {
      if (buf.dropReason === "buffered_bytes_budget") {
        pressure.recordDrop("buffered_bytes_budget", interactionId);
      }
      releaseCaptureBytes(pressure, buf);
      pressure.releaseContext();
      return;
    }

    if (res.errored != null) {
      buf.terminalHostError = true;
    }

    if (
      !shouldPersistInteraction(captureMode, {
        status: buf.statusCode,
        terminalHostError: buf.terminalHostError,
      })
    ) {
      scheduleCaptureModeDrop({
        interactionId,
        reservedBytes: buf.reservedBytes,
        emit,
        pressure,
      });
      buf.reservedBytes = 0;
      return;
    }

    const reservedForJob = buf.reservedBytes;
    buf.reservedBytes = 0;

    const enqueued = queue.tryEnqueue(async () => {
      try {
        const capture = buildObservedCapture(
          interactionId,
          req,
          buf,
          captureMode,
        );
        const finalized = finalizeObservation(
          capture,
          emit ? { onEvent: emit } : {},
        );
        if (finalized === null) {
          return;
        }
        await persistFinalizedInteraction(storage, finalized, emit);
      } finally {
        pressure.releaseBytes(reservedForJob);
        pressure.releaseContext();
      }
    });

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

/** Off hot path, without consuming persist queue depth. */
function scheduleCaptureModeDrop(input: {
  interactionId: string;
  reservedBytes: number;
  emit: EmitWideEvent | undefined;
  pressure: PressureController;
}): void {
  const { interactionId, reservedBytes, emit, pressure } = input;
  setImmediate(() => {
    try {
      emit?.({
        type: "interaction_dropped",
        reason: "capture_mode_filter",
        interactionId,
      });
    } finally {
      pressure.releaseBytes(reservedBytes);
      pressure.releaseContext();
    }
  });
}
