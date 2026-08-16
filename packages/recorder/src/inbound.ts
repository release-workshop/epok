import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachRuntime } from "./attach-runtime.js";
import {
  expectsInboundBody,
  inboundSnapshotFromNode,
  installInboundBodyCapture,
  installResponseCapture,
  noteInboundTerminal,
  skipOrElideNodeContentLength,
  type CaptureBuffers,
} from "./capture.js";
import { requestContext, type RequestCaptureContext } from "./context.js";

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

function runCaptureRequest(input: {
  runtime: AttachRuntime;
  ctx: RequestCaptureContext;
  buf: CaptureBuffers;
  req: IncomingMessage;
  res: ServerResponse;
  emitHost: () => boolean;
}): boolean {
  const { runtime, ctx, buf, req, res, emitHost } = input;
  try {
    if (expectsInboundBody(req)) {
      if (!skipOrElideNodeContentLength(runtime.pressure, buf, req)) {
        installInboundBodyCapture(req, buf, runtime.pressure);
      }
    }
    installResponseCapture(res, buf, runtime.pressure);
  } catch {
    // Fail-open.
  }

  runtime.observeInbound(ctx, inboundRequestFromNode(req));

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    runtime.trackSettle(
      runtime.settle({
        interactionId: ctx.interactionId,
        buf,
        inbound: inboundSnapshotFromNode(req),
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
    runtime.observeResponse(
      ctx,
      new Response(null, { status: res.statusCode }),
    );
    settle();
  });
  res.once("close", () => {
    if (res.headersSent) noteInboundTerminal(buf, res);
    settle();
  });

  try {
    return emitHost();
  } catch (err) {
    buf.terminalHostError = true;
    settle();
    throw err;
  }
}

/**
 * Patch `http.Server` so each inbound request runs inside AsyncLocalStorage,
 * collects a capture buffer, and settles via the shared attach runtime.
 * Returns a restore function.
 */
export function installInboundAttach(runtime: AttachRuntime): () => void {
  const originalEmit: typeof http.Server.prototype.emit = Reflect.get(
    http.Server.prototype,
    "emit",
  );

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
    const begun = runtime.begin();
    const emitHost = (): boolean =>
      Reflect.apply(originalEmit, this, [event, ...args]) as boolean;

    if (begun.kind === "disabled") {
      return requestContext.run(begun.ctx, emitHost);
    }

    if (begun.kind === "shed") {
      return requestContext.run(begun.ctx, () => {
        runtime.observeInbound(begun.ctx, inboundRequestFromNode(req));
        res.once("finish", () => {
          runtime.observeResponse(
            begun.ctx,
            new Response(null, { status: res.statusCode }),
          );
        });
        return emitHost();
      });
    }

    const { ctx, buf } = begun;
    return requestContext.run(ctx, () =>
      runCaptureRequest({ runtime, ctx, buf, req, res, emitHost }),
    );
  }

  http.Server.prototype.emit = patchedEmit as typeof http.Server.prototype.emit;
  return () => {
    http.Server.prototype.emit = originalEmit;
  };
}
