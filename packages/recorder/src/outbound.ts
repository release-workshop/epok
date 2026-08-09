import type { RecorderObservationHooks } from "@epok/core";
import {
  beginBodyRead,
  endBodyRead,
  headersToFields,
  readFetchBodies,
  type CaptureBuffers,
} from "./capture.js";
import { requestContext } from "./context.js";
import type { ObservedDependency } from "./finalize.js";
import type { EmitWideEvent } from "./observe.js";
import { observeDependency } from "./observe.js";
import type { PressureController } from "./pressure.js";

/**
 * Wrap `globalThis.fetch` so outbound calls are associated with the current
 * request context and dependency bodies are collected into the capture buffer.
 * Always fail-open: observation errors never reject fetch.
 */
export function installFetchIntercept(
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent | undefined,
  pressure: PressureController,
  enabled = true,
): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Structural no-op: still pay for ALS lookup + wrapper frame.
    if (!enabled) {
      void requestContext.getStore();
      return originalFetch(input, init);
    }

    const ctx = requestContext.getStore();
    const startedAt = ctx?.capture
      ? performance.now() - ctx.capture.startedAt
      : 0;

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      observeDependency(ctx, input, init, null, hooks, emit);
      if (ctx?.capture && !ctx.capture.dropped) {
        recordDependencyError(ctx.capture, input, init, startedAt, err);
      }
      throw err;
    }

    observeDependency(ctx, input, init, response, hooks, emit);

    if (ctx?.capture && !ctx.capture.dropped) {
      scheduleDependencyCapture(
        ctx.capture,
        input,
        init,
        response,
        startedAt,
        pressure,
      );
    }

    return response;
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function scheduleDependencyCapture(
  buf: CaptureBuffers,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
  startedAt: number,
  pressure: PressureController,
): void {
  beginBodyRead(buf);
  const seq = buf.dependencies.length + 1;
  // Placeholder so seq ordering is stable even if body read finishes out of order.
  const placeholder: ObservedDependency = {
    seq,
    startedAt: Math.max(0, Math.round(startedAt)),
    endedAt: Math.max(0, Math.round(performance.now() - buf.startedAt)),
    request: {
      protocol: "HTTP/1.1",
      method: "GET",
      url: "",
      headers: [],
      body: new Uint8Array(),
    },
    response: null,
  };
  buf.dependencies.push(placeholder);

  void (async () => {
    try {
      const request = new Request(input, init);
      const { requestBody, responseBody } = await readFetchBodies(
        request,
        response,
        pressure,
        buf,
      );
      const endedAt = Math.max(
        placeholder.startedAt,
        Math.round(performance.now() - buf.startedAt),
      );
      placeholder.endedAt = endedAt;
      placeholder.request = {
        protocol: "HTTP/1.1",
        method: request.method,
        url: request.url,
        headers: headersToFields(request.headers),
        body: requestBody,
        contentType: request.headers.get("content-type"),
      };
      placeholder.response = {
        protocol: "HTTP/1.1",
        status: response.status,
        statusText: response.statusText,
        headers: headersToFields(response.headers),
        body: responseBody,
        contentType: response.headers.get("content-type"),
      };
    } catch {
      // Fail-open: leave placeholder / partial row.
    } finally {
      endBodyRead(buf);
    }
  })();
}

function recordDependencyError(
  buf: CaptureBuffers,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startedAt: number,
  err: unknown,
): void {
  try {
    const request = new Request(input, init);
    const endedAt = Math.max(0, Math.round(performance.now() - buf.startedAt));
    buf.dependencies.push({
      seq: buf.dependencies.length + 1,
      startedAt: Math.max(0, Math.round(startedAt)),
      endedAt,
      request: {
        protocol: "HTTP/1.1",
        method: request.method,
        url: request.url,
        headers: headersToFields(request.headers),
        body: new Uint8Array(),
        contentType: request.headers.get("content-type"),
      },
      response: null,
      error: {
        type: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } catch {
    // Fail-open.
  }
}
