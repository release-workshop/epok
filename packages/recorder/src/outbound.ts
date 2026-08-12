import type { RecorderObservationHooks } from "@epok/core";
import {
  beginBodyRead,
  endBodyRead,
  headersToFields,
  readBufferedBodyInit,
  skipOrElideBufferedBodyInit,
  skipOrElideContentLength,
  skipOrElideKnownSize,
  takeCapturedBytes,
  teeFetchResponseBody,
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
      ctx.capture.interactionId ??= ctx.interactionId;
      if (
        skipOrElideBufferedBodyInit(pressure, ctx.capture, init?.body) ||
        skipOrElideContentLength(pressure, ctx.capture, response.headers)
      ) {
        recordDependencyWithoutBodies({
          buf: ctx.capture,
          input,
          init,
          response,
          startedAt,
        });
        return response;
      }
      return scheduleDependencyCapture(
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
): Response {
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

  const teed = teeFetchResponseBody(response);
  const appResponse = teed.response;
  const captureBody = teed.captureBody;

  void (async () => {
    try {
      const request = new Request(input, init);
      const requestBody = await readOutboundRequestBody(
        request,
        init,
        pressure,
        buf,
      );
      const responseBody = takeCapturedBytes(pressure, buf, await captureBody);
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

  return appResponse;
}

async function readOutboundRequestBody(
  request: Request,
  init: RequestInit | undefined,
  pressure: PressureController,
  buf: CaptureBuffers,
): Promise<Uint8Array> {
  try {
    const buffered = readBufferedBodyInit(init?.body);
    if (buffered !== null) {
      if (skipOrElideKnownSize(pressure, buf, buffered.byteLength)) {
        return new Uint8Array();
      }
      return takeCapturedBytes(pressure, buf, buffered);
    }
    // Request constructed solely for capture — consume once, no clone.
    if (!request.body) return new Uint8Array();
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && contentLength !== "") {
      const length = Number(contentLength);
      if (
        Number.isFinite(length) &&
        length >= 0 &&
        skipOrElideKnownSize(pressure, buf, length)
      ) {
        return new Uint8Array();
      }
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (skipOrElideKnownSize(pressure, buf, bytes.byteLength)) {
      return new Uint8Array();
    }
    return takeCapturedBytes(pressure, buf, bytes);
  } catch {
    return new Uint8Array();
  }
}

function recordDependencyWithoutBodies(input: {
  buf: CaptureBuffers;
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  response: Response;
  startedAt: number;
}): void {
  const { buf, input: fetchInput, init, response, startedAt } = input;
  const seq = buf.dependencies.length + 1;
  const started = Math.max(0, Math.round(startedAt));
  const endedAt = Math.max(
    started,
    Math.round(performance.now() - buf.startedAt),
  );
  const emptyResponse = {
    protocol: "HTTP/1.1",
    status: response.status,
    statusText: response.statusText,
    headers: headersToFields(response.headers),
    body: new Uint8Array(),
    contentType: response.headers.get("content-type"),
  };
  try {
    const request = new Request(fetchInput, init);
    buf.dependencies.push({
      seq,
      startedAt: started,
      endedAt,
      request: {
        protocol: "HTTP/1.1",
        method: request.method,
        url: request.url,
        headers: headersToFields(request.headers),
        body: new Uint8Array(),
        contentType: request.headers.get("content-type"),
      },
      response: emptyResponse,
    });
  } catch {
    buf.dependencies.push({
      seq,
      startedAt: started,
      endedAt,
      request: {
        protocol: "HTTP/1.1",
        method: "GET",
        url: "",
        headers: [],
        body: new Uint8Array(),
      },
      response: emptyResponse,
    });
  }
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
