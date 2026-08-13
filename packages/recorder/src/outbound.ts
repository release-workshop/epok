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
import type { ObservedDependency, ObservedHttpRequest } from "./finalize.js";
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
    const buf = ctx?.capture;
    const startedAt = buf ? performance.now() - buf.startedAt : 0;
    const row =
      buf && !buf.dropped && !buf.frozen
        ? beginDependencyRow(buf, input, init, startedAt)
        : undefined;
    if (buf && row) {
      buf.interactionId ??= ctx.interactionId;
    }

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      observeDependency(ctx, input, init, null, hooks, emit);
      if (row && buf && !buf.dropped && !buf.frozen) {
        finishDependencyError(row, buf, err);
      }
      throw err;
    }

    observeDependency(ctx, input, init, response, hooks, emit);

    if (row && buf && !buf.dropped && !buf.frozen) {
      row.networkReturned = true;
    }

    if (!row || !buf || buf.dropped || buf.frozen) {
      return response;
    }

    if (
      skipOrElideBufferedBodyInit(pressure, buf, init?.body) ||
      skipOrElideContentLength(pressure, buf, response.headers)
    ) {
      finishDependencyWithoutBodies(row, buf, input, init, response);
      return response;
    }
    return scheduleDependencyCapture(row, buf, input, init, response, pressure);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Push an invoke-ordered row before the network returns. Does not consume the body. */
function beginDependencyRow(
  buf: CaptureBuffers,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startedAt: number,
): ObservedDependency {
  const started = Math.max(0, Math.round(startedAt));
  const row: ObservedDependency = {
    seq: buf.dependencies.length + 1,
    startedAt: started,
    endedAt: started,
    request: peekFetchRequestLine(input, init),
    response: null,
  };
  buf.dependencies.push(row);
  return row;
}

function peekFetchRequestLine(
  input: RequestInfo | URL,
  init?: RequestInit,
): ObservedHttpRequest {
  try {
    let method = "GET";
    let url = "";
    let headers: Headers;
    if (typeof input === "string") {
      url = input;
      method = init?.method ?? "GET";
      headers = new Headers(init?.headers);
    } else if (input instanceof URL) {
      url = input.href;
      method = init?.method ?? "GET";
      headers = new Headers(init?.headers);
    } else {
      url = input.url;
      method = init?.method ?? input.method;
      headers = new Headers(input.headers);
      if (init?.headers !== undefined) {
        new Headers(init.headers).forEach((value, name) => {
          headers.set(name, value);
        });
      }
    }
    return {
      protocol: "HTTP/1.1",
      method,
      url,
      headers: headersToFields(headers),
      body: new Uint8Array(),
      contentType: headers.get("content-type"),
    };
  } catch {
    return {
      protocol: "HTTP/1.1",
      method: "GET",
      url: "",
      headers: [],
      body: new Uint8Array(),
    };
  }
}

function scheduleDependencyCapture(
  row: ObservedDependency,
  buf: CaptureBuffers,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
  pressure: PressureController,
): Response {
  beginBodyRead(buf);
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
      if (buf.dropped || (buf.frozen && !row.networkReturned)) return;
      const endedAt = Math.max(
        row.startedAt,
        Math.round(performance.now() - buf.startedAt),
      );
      row.endedAt = endedAt;
      row.request = {
        protocol: "HTTP/1.1",
        method: request.method,
        url: request.url,
        headers: headersToFields(request.headers),
        body: requestBody,
        contentType: request.headers.get("content-type"),
      };
      row.response = {
        protocol: "HTTP/1.1",
        status: response.status,
        statusText: response.statusText,
        headers: headersToFields(response.headers),
        body: responseBody,
        contentType: response.headers.get("content-type"),
      };
    } catch {
      // Fail-open: leave invoke-time row (possibly unterminated).
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

function finishDependencyWithoutBodies(
  row: ObservedDependency,
  buf: CaptureBuffers,
  fetchInput: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
): void {
  if (buf.dropped || (buf.frozen && !row.networkReturned)) return;
  const endedAt = Math.max(
    row.startedAt,
    Math.round(performance.now() - buf.startedAt),
  );
  row.endedAt = endedAt;
  row.response = {
    protocol: "HTTP/1.1",
    status: response.status,
    statusText: response.statusText,
    headers: headersToFields(response.headers),
    body: new Uint8Array(),
    contentType: response.headers.get("content-type"),
  };
  try {
    const request = new Request(fetchInput, init);
    row.request = {
      protocol: "HTTP/1.1",
      method: request.method,
      url: request.url,
      headers: headersToFields(request.headers),
      body: new Uint8Array(),
      contentType: request.headers.get("content-type"),
    };
  } catch {
    // Keep invoke-time request line.
  }
}

function finishDependencyError(
  row: ObservedDependency,
  buf: CaptureBuffers,
  err: unknown,
): void {
  if (buf.dropped || (buf.frozen && !row.networkReturned)) return;
  row.endedAt = Math.max(
    row.startedAt,
    Math.round(performance.now() - buf.startedAt),
  );
  row.response = null;
  row.error = {
    type: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
  };
}
