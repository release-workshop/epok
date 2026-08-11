import type { RecorderObservationHooks } from "@epok/core";
import type { RequestCaptureContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";
import { safeObserve, type EmitWideEvent } from "./observe.js";

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function observeInboundFetch(
  ctx: RequestCaptureContext,
  request: Request,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  if (!emit && !hooks?.onInbound) return;
  safeObserve(emit, ctx.interactionId, () => {
    emit?.({
      type: "observed",
      phase: "inbound",
      interactionId: ctx.interactionId,
      method: request.method,
      url: request.url,
      requestHeaders: headerMap(request.headers),
    });
    hooks?.onInbound?.(request);
  });
}

export function observeResponseFetch(
  ctx: RequestCaptureContext,
  request: Request,
  response: Response,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  if (!emit && !hooks?.onResponse) return;
  safeObserve(emit, ctx.interactionId, () => {
    emit?.({
      type: "observed",
      phase: "response",
      interactionId: ctx.interactionId,
      method: request.method,
      url: request.url,
      status: response.status,
    });
    hooks?.onResponse?.(response);
  });
}

export type { RecorderWideEvent };
