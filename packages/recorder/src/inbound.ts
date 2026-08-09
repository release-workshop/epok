import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import {
  buildObservedCapture,
  expectsInboundBody,
  installInboundBodyCapture,
  installResponseCapture,
  releaseCaptureBytes,
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
  const { enabled, hooks, emit, storage, pressure, queue } = deps;
  // Bound later via Reflect.apply with an explicit receiver.
  const originalEmit: ServerEmit = Reflect.get(http.Server.prototype, "emit");

  function patchedEmit(
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "request" && args.length >= 2) {
      const req = args[0] as IncomingMessage;
      const res = args[1] as ServerResponse;

      // Structural no-op: keep wrapper + ALS cost without capture/persist.
      if (!enabled) {
        const ctx = createCaptureContext(false);
        return requestContext.run(
          ctx,
          () => Reflect.apply(originalEmit, this, [event, ...args]) as boolean,
        );
      }

      pressure.recordObserved();
      // Under active shedding, skip capture entirely (true no-op collect) so
      // memory stays bounded by configured budgets instead of per-request buffers.
      const acquired = !pressure.sheddingActive && pressure.tryAcquireContext();
      const ctx = createCaptureContext(acquired);

      if (!acquired) {
        const reason = pressure.sheddingActive
          ? "queue_full"
          : "active_contexts_budget";
        pressure.recordDrop(reason, ctx.interactionId);
        // Still enter ALS so outbound fetch can see a context id for pairing,
        // but capture is null → no collect / no enqueue.
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
            installInboundBodyCapture(req, buf, pressure);
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
          void settleAndEnqueue(ctx.interactionId, req, buf);
        };
        res.once("finish", () => {
          observeResponse(ctx, req, res, hooks, emit);
          settle();
        });
        res.once("close", () => {
          // Aborted / truncated responses still release budgets.
          settle();
        });

        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      });
    }
    return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
  }

  async function settleAndEnqueue(
    interactionId: string,
    req: IncomingMessage,
    buf: CaptureBuffers,
  ): Promise<void> {
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

      const reservedForJob = buf.reservedBytes;
      // Ownership of reserved bytes transfers to the queue job until done.
      buf.reservedBytes = 0;

      const captureReq = req;
      const enqueued = queue.tryEnqueue(async () => {
        try {
          const capture = buildObservedCapture(interactionId, captureReq, buf);
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

  http.Server.prototype.emit = patchedEmit as ServerEmit;

  return () => {
    http.Server.prototype.emit = originalEmit;
  };
}
