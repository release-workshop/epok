import {
  beginBodyRead,
  endBodyRead,
  headersToFields,
  skipOrElideContentLength,
  takeCapturedBytes,
  teeFetchResponseBody,
  type CaptureBuffers,
  type InboundSnapshot,
} from "./capture.js";
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

export function inboundSnapshotFromFetch(request: Request): InboundSnapshot {
  return {
    protocol: "HTTP/1.1",
    method: request.method,
    url: request.url,
    headers: headersToFields(request.headers),
    contentType: request.headers.get("content-type"),
  };
}
