import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecorderObservationHooks } from "@epok/core";
import type { RequestCaptureContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";

export type EmitWideEvent = ((event: RecorderWideEvent) => void) & {
  /**
   * Whether this subscriber would receive events of `type`.
   * Callers skip constructing payloads when this returns false.
   */
  includes(type: RecorderWideEvent["type"]): boolean;
};

function headerMap(
  headers: Headers | IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function inboundRequestFromNode(req: IncomingMessage): Request {
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

export function safeObserve(
  emit: EmitWideEvent | undefined,
  interactionId: string | undefined,
  work: () => void,
): void {
  try {
    work();
  } catch (err) {
    try {
      emit?.({
        type: "observation_dropped",
        reason: "observer_threw",
        ...(interactionId !== undefined ? { interactionId } : {}),
        cause: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Fail-open: never throw from diagnostics.
    }
  }
}

export function observeInbound(
  ctx: RequestCaptureContext,
  req: IncomingMessage,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  const emitObserved = emit?.includes("observed") === true;
  if (!emitObserved && !hooks?.onInbound) return;
  safeObserve(emit, ctx.interactionId, () => {
    const request = inboundRequestFromNode(req);
    if (emitObserved) {
      emit({
        type: "observed",
        phase: "inbound",
        interactionId: ctx.interactionId,
        method: request.method,
        url: request.url,
        requestHeaders: headerMap(request.headers),
      });
    }
    hooks?.onInbound?.(request);
  });
}

export function observeResponse(
  ctx: RequestCaptureContext,
  req: IncomingMessage,
  res: ServerResponse,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  const emitObserved = emit?.includes("observed") === true;
  if (!emitObserved && !hooks?.onResponse) return;
  safeObserve(emit, ctx.interactionId, () => {
    const request = inboundRequestFromNode(req);
    if (emitObserved) {
      emit({
        type: "observed",
        phase: "response",
        interactionId: ctx.interactionId,
        method: request.method,
        url: request.url,
        status: res.statusCode,
      });
    }
    hooks?.onResponse?.(new Response(null, { status: res.statusCode }));
  });
}

export function observeDependency(
  ctx: RequestCaptureContext | undefined,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response | null,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  const emitObserved = emit?.includes("observed") === true;
  const emitMissing = emit?.includes("context_missing") === true;
  if (!emitObserved && !emitMissing && !hooks?.onDependency) return;
  safeObserve(emit, ctx?.interactionId, () => {
    const request = new Request(input, init);
    if (!ctx) {
      if (emitMissing) {
        emit({
          type: "context_missing",
          phase: "dependency",
          reason: "no_request_context",
          method: request.method,
          url: request.url,
        });
      }
      return;
    }

    if (emitObserved) {
      emit({
        type: "observed",
        phase: "dependency",
        interactionId: ctx.interactionId,
        method: request.method,
        url: request.url,
        requestHeaders: headerMap(request.headers),
        ...(response ? { status: response.status } : {}),
      });
    }
    hooks?.onDependency?.(request, response);
  });
}
