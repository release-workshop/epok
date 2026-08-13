import type { CaptureMode } from "./capture-mode.js";
import type { RuntimeIdentity } from "@epok/core";
import {
  beginBodyRead,
  endBodyRead,
  headersToFields,
  skipOrElideContentLength,
  takeCapturedBytes,
  teeFetchResponseBody,
  type CaptureBuffers,
} from "./capture.js";
import type { ObservedCapture } from "./finalize.js";
import type { PressureController } from "./pressure.js";

export function expectsFetchInboundBody(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    return true;
  }
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 0) return true;
  return request.headers.has("transfer-encoding");
}

/** Read inbound body from a clone without consuming the app-visible request. */
export function readFetchInboundBody(
  request: Request,
  buf: CaptureBuffers,
  pressure: PressureController,
): void {
  if (!expectsFetchInboundBody(request)) return;
  if (skipOrElideContentLength(pressure, buf, request.headers)) {
    return;
  }
  beginBodyRead(buf);
  void (async () => {
    try {
      const body = request.body;
      if (!body) {
        buf.inboundBody = new Uint8Array();
        return;
      }
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      buf.inboundBody = takeCapturedBytes(pressure, buf, bytes);
    } catch {
      // Fail-open.
    } finally {
      endBodyRead(buf);
    }
  })();
}

/** Tee response body for capture; returns the app-visible Response. */
export function captureFetchResponse(
  response: Response,
  buf: CaptureBuffers,
  pressure: PressureController,
): Response {
  buf.statusCode = response.status;
  buf.statusText = response.statusText;
  buf.inboundTerminalObserved = true;
  buf.responseHeaders = headersToFields(response.headers);
  if (buf.responseStartedAt === 0) {
    buf.responseStartedAt = performance.now() - buf.startedAt;
  }
  if (skipOrElideContentLength(pressure, buf, response.headers)) {
    buf.responseBody = new Uint8Array();
    buf.responseEndedAt = performance.now() - buf.startedAt;
    return response;
  }
  beginBodyRead(buf);
  const teed = teeFetchResponseBody(response);

  void (async () => {
    try {
      const body = await teed.captureBody;
      buf.responseBody = takeCapturedBytes(pressure, buf, body);
      buf.responseEndedAt = performance.now() - buf.startedAt;
    } catch {
      // Fail-open.
    } finally {
      endBodyRead(buf);
    }
  })();

  return teed.response;
}

export function buildObservedCaptureFromFetch(
  interactionId: string,
  request: Request,
  response: Response | null,
  buf: CaptureBuffers,
  captureMode?: CaptureMode,
  runtime?: RuntimeIdentity,
): ObservedCapture {
  const inbound = {
    protocol: "HTTP/1.1",
    method: request.method,
    url: request.url,
    headers: headersToFields(request.headers),
    body: buf.inboundBody,
    contentType: request.headers.get("content-type"),
  };

  const status = response?.status ?? buf.statusCode;
  const responseMessage: ObservedCapture["response"] =
    response !== null && status !== undefined
      ? {
          protocol: "HTTP/1.1",
          status,
          headers: buf.responseHeaders,
          body: buf.responseBody,
          contentType:
            buf.responseHeaders.find(
              (h) => h.name.toLowerCase() === "content-type",
            )?.value ??
            response.headers.get("content-type") ??
            null,
          startedAt: Math.max(0, Math.round(buf.responseStartedAt)),
          endedAt: Math.max(
            Math.round(buf.responseStartedAt),
            Math.round(buf.responseEndedAt),
          ),
          ...(buf.statusText || response.statusText
            ? { statusText: buf.statusText || response.statusText }
            : {}),
        }
      : null;

  return {
    id: interactionId,
    capturedAt: new Date().toISOString(),
    inbound,
    dependencies: buf.dependencies,
    response: responseMessage,
    ...(captureMode !== undefined ? { captureMode } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  };
}
