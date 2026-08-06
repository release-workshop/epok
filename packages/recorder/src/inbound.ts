import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecorderObservationHooks } from "@epok/core";
import { createCaptureContext, requestContext } from "./context.js";
import type { EmitWideEvent } from "./observe.js";
import { observeInbound, observeResponse } from "./observe.js";

type ServerEmit = typeof http.Server.prototype.emit;

/**
 * Patch `http.Server` so each inbound request runs inside AsyncLocalStorage
 * and emits observe-only inbound/response events. Returns a restore function.
 */
export function installInboundAttach(
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent,
): () => void {
  const originalEmit = http.Server.prototype.emit;

  function patchedEmit(
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "request" && args.length >= 2) {
      const req = args[0] as IncomingMessage;
      const res = args[1] as ServerResponse;
      const ctx = createCaptureContext();
      return requestContext.run(ctx, () => {
        observeInbound(ctx, req, hooks, emit);
        res.once("finish", () => {
          observeResponse(ctx, req, res, hooks, emit);
        });
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      });
    }
    return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
  }

  http.Server.prototype.emit = patchedEmit as ServerEmit;

  return () => {
    http.Server.prototype.emit = originalEmit;
  };
}
