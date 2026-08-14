import type { RecorderObservationHooks } from "@epok/core";
import type { RequestCaptureContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";

export type EmitWideEvent = (event: RecorderWideEvent) => void;

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
  request: Request,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  if (!hooks?.onInbound) return;
  safeObserve(emit, ctx.interactionId, () => {
    hooks.onInbound?.(request);
  });
}

export function observeResponse(
  ctx: RequestCaptureContext,
  response: Response,
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
): void {
  if (!hooks?.onResponse) return;
  safeObserve(emit, ctx.interactionId, () => {
    hooks.onResponse?.(response);
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
  if (!ctx) {
    if (!emit) return;
    safeObserve(emit, undefined, () => {
      const request = new Request(input, init);
      emit({
        type: "context_missing",
        phase: "dependency",
        reason: "no_request_context",
        method: request.method,
        url: request.url,
      });
    });
    return;
  }

  if (!hooks?.onDependency) return;
  safeObserve(emit, ctx.interactionId, () => {
    const request = new Request(input, init);
    hooks.onDependency?.(request, response);
  });
}
