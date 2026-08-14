import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import type { CaptureMode } from "./capture-mode.js";
import {
  expectsInboundBody,
  inboundSnapshotFromNode,
  installInboundBodyCapture,
  installResponseCapture,
  noteInboundTerminal,
  skipOrElideNodeContentLength,
} from "./capture.js";
import { createCaptureContext, requestContext } from "./context.js";
import type { EmitWideEvent } from "./observe.js";
import { observeInbound, observeResponse } from "./observe.js";
import type { PressureController } from "./pressure.js";
import type { BoundedAsyncQueue } from "./queue.js";
import { settleInteraction } from "./settle.js";

type ServerEmit = typeof http.Server.prototype.emit;

function inboundRequestFromNode(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const path = req.url ?? "/";
  const url = `http://${host}${path}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
  });
}

export interface InboundAttachDeps {
  /** When false, wrappers + ALS stay active but capture/persist are skipped. */
  enabled: boolean;
  captureMode: CaptureMode;
  hooks: RecorderObservationHooks | undefined;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  queue: BoundedAsyncQueue;
  trackSettle: (promise: Promise<void>) => void;
}

/**
 * Patch `http.Server` so each inbound request runs inside AsyncLocalStorage,
 * collects a capture buffer, and enqueues sanitize/finalize/persist off-path.
 * Returns a restore function.
 */
export function installInboundAttach(deps: InboundAttachDeps): () => void {
  const {
    enabled,
    captureMode,
    hooks,
    emit,
    storage,
    pressure,
    queue,
    trackSettle,
  } = deps;
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
        observeInbound(ctx, inboundRequestFromNode(req), hooks, emit);
        res.once("finish", () => {
          observeResponse(
            ctx,
            new Response(null, { status: res.statusCode }),
            hooks,
            emit,
          );
        });
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      });
    }

    return requestContext.run(ctx, () => {
      const buf = ctx.capture;
      if (!buf) {
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      }
      buf.interactionId = ctx.interactionId;
      try {
        if (expectsInboundBody(req)) {
          if (!skipOrElideNodeContentLength(pressure, buf, req)) {
            installInboundBodyCapture(req, buf, pressure);
          }
        }
        installResponseCapture(res, buf, pressure);
      } catch {
        // Fail-open.
      }

      observeInbound(ctx, inboundRequestFromNode(req), hooks, emit);

      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        trackSettle(
          settleInteraction({
            interactionId: ctx.interactionId,
            buf,
            inbound: inboundSnapshotFromNode(req),
            captureMode,
            emit,
            storage,
            pressure,
            queue,
            deferOffHotPath: (work) => {
              setImmediate(work);
            },
            refreshTerminal: () => {
              if (res.errored != null) {
                buf.terminalHostError = true;
              }
              if (res.headersSent) noteInboundTerminal(buf, res);
            },
          }),
        );
      };
      res.once("finish", () => {
        noteInboundTerminal(buf, res);
        observeResponse(
          ctx,
          new Response(null, { status: res.statusCode }),
          hooks,
          emit,
        );
        settle();
      });
      res.once("close", () => {
        if (res.headersSent) noteInboundTerminal(buf, res);
        settle();
      });

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
