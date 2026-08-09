import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeaderField } from "@epok/core";
import type {
  ObservedCapture,
  ObservedDependency,
  ObservedHttpRequest,
  ObservedHttpResponse,
} from "./finalize.js";
import type { PressureController } from "./pressure.js";

export interface CaptureBuffers {
  inboundBody: Uint8Array;
  responseBody: Uint8Array;
  responseHeaders: HeaderField[];
  statusCode: number;
  statusText: string;
  dependencies: ObservedDependency[];
  /** Monotonic ms from Interaction start. */
  startedAt: number;
  responseStartedAt: number;
  responseEndedAt: number;
  pendingBodyReads: number;
  reservedBytes: number;
  dropped: boolean;
  dropReason?: string;
  bodyWaiters: Array<() => void>;
}

export interface RequestCaptureContext {
  interactionId: string;
  capture: CaptureBuffers | null;
}

export function createCaptureBuffers(): CaptureBuffers {
  return {
    inboundBody: new Uint8Array(),
    responseBody: new Uint8Array(),
    responseHeaders: [],
    statusCode: 200,
    statusText: "",
    dependencies: [],
    startedAt: performance.now(),
    responseStartedAt: 0,
    responseEndedAt: 0,
    pendingBodyReads: 0,
    reservedBytes: 0,
    dropped: false,
    bodyWaiters: [],
  };
}

export function headersToFields(
  headers:
    IncomingMessage["headers"] | Headers | Map<string, string | string[]>,
): HeaderField[] {
  const fields: HeaderField[] = [];
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      fields.push({ name, value });
    });
    return fields;
  }
  if (headers instanceof Map) {
    for (const [name, value] of headers) {
      fields.push({
        name,
        value: Array.isArray(value) ? value.join(", ") : value,
      });
    }
    return fields;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    fields.push({
      name,
      value: Array.isArray(value) ? value.join(", ") : value,
    });
  }
  return fields;
}

export function nodeRequestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const path = req.url ?? "/";
  return `http://${host}${path}`;
}

export function markDropped(buf: CaptureBuffers, reason: string): void {
  buf.dropped = true;
  buf.dropReason = reason;
}

export function beginBodyRead(buf: CaptureBuffers): void {
  buf.pendingBodyReads += 1;
}

export function endBodyRead(buf: CaptureBuffers): void {
  buf.pendingBodyReads = Math.max(0, buf.pendingBodyReads - 1);
  if (buf.pendingBodyReads === 0) {
    const waiters = buf.bodyWaiters.splice(0);
    for (const w of waiters) w();
  }
}

export function waitForBodyReads(buf: CaptureBuffers): Promise<void> {
  if (buf.pendingBodyReads === 0) return Promise.resolve();
  return new Promise((resolve) => {
    buf.bodyWaiters.push(resolve);
  });
}

/**
 * Reserve buffered bytes under the global budget. On failure marks the
 * Interaction dropped so enqueue will shed it.
 */
export function reserveCaptureBytes(
  pressure: PressureController,
  buf: CaptureBuffers,
  bytes: number,
): boolean {
  if (buf.dropped) return false;
  if (!pressure.tryReserveBytes(bytes)) {
    markDropped(buf, "buffered_bytes_budget");
    return false;
  }
  buf.reservedBytes += bytes;
  return true;
}

export function releaseCaptureBytes(
  pressure: PressureController,
  buf: CaptureBuffers,
): void {
  if (buf.reservedBytes <= 0) return;
  pressure.releaseBytes(buf.reservedBytes);
  buf.reservedBytes = 0;
}

function chunkToBuffer(
  chunk: unknown,
  encoding?: BufferEncoding,
): Buffer | null {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return null;
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  return null;
}

/** Capture response bytes by wrapping write/end (fail-open). */
export function installResponseCapture(
  res: ServerResponse,
  buf: CaptureBuffers,
  pressure: PressureController,
): void {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((
    chunk: unknown,
    encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void,
  ) => {
    try {
      if (buf.responseStartedAt === 0) {
        buf.responseStartedAt = performance.now() - buf.startedAt;
      }
      const bufChunk = chunkToBuffer(
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
      if (bufChunk && reserveCaptureBytes(pressure, buf, bufChunk.byteLength)) {
        chunks.push(bufChunk);
      }
    } catch {
      // Fail-open.
    }
    if (typeof encoding === "function") {
      return originalWrite(chunk, encoding);
    }
    return originalWrite(chunk, encoding as BufferEncoding, cb);
  }) as typeof res.write;

  res.end = ((
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    cb?: () => void,
  ) => {
    try {
      if (buf.responseStartedAt === 0) {
        buf.responseStartedAt = performance.now() - buf.startedAt;
      }
      const bufChunk = chunkToBuffer(
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
      if (bufChunk && reserveCaptureBytes(pressure, buf, bufChunk.byteLength)) {
        chunks.push(bufChunk);
      }
      buf.responseBody = Buffer.concat(chunks);
      buf.statusCode = res.statusCode;
      buf.statusText = res.statusMessage || "";
      buf.responseHeaders = headersToFields(
        res.getHeaders() as IncomingMessage["headers"],
      );
      buf.responseEndedAt = performance.now() - buf.startedAt;
    } catch {
      // Fail-open.
    }
    if (typeof chunk === "function") {
      return originalEnd(chunk as () => void);
    }
    if (typeof encoding === "function") {
      return originalEnd(chunk as never, encoding);
    }
    return originalEnd(chunk as never, encoding as BufferEncoding, cb);
  }) as typeof res.end;
}

/** Best-effort inbound body tee via push hook (does not consume the stream). */
export function installInboundBodyCapture(
  req: IncomingMessage,
  buf: CaptureBuffers,
  pressure: PressureController,
): void {
  const chunks: Buffer[] = [];
  const originalPush = req.push.bind(req);
  req.push = (chunk: unknown, encoding?: BufferEncoding) => {
    try {
      if (chunk) {
        const bufChunk = chunkToBuffer(chunk, encoding);
        if (
          bufChunk &&
          reserveCaptureBytes(pressure, buf, bufChunk.byteLength)
        ) {
          chunks.push(bufChunk);
        }
      } else {
        buf.inboundBody = Buffer.concat(chunks);
      }
    } catch {
      // Fail-open.
    }
    return originalPush(chunk, encoding);
  };
}

export function buildObservedCapture(
  interactionId: string,
  req: IncomingMessage,
  buf: CaptureBuffers,
): ObservedCapture {
  const inbound: ObservedHttpRequest = {
    protocol: `HTTP/${req.httpVersion}`,
    method: req.method ?? "GET",
    url: nodeRequestUrl(req),
    headers: headersToFields(req.headers),
    body: buf.inboundBody,
    contentType:
      typeof req.headers["content-type"] === "string"
        ? req.headers["content-type"]
        : null,
  };

  const response: ObservedHttpResponse & {
    startedAt: number;
    endedAt: number;
  } = {
    protocol: `HTTP/${req.httpVersion}`,
    status: buf.statusCode,
    headers: buf.responseHeaders,
    body: buf.responseBody,
    contentType:
      buf.responseHeaders.find((h) => h.name.toLowerCase() === "content-type")
        ?.value ?? null,
    startedAt: Math.max(0, Math.round(buf.responseStartedAt)),
    endedAt: Math.max(
      Math.round(buf.responseStartedAt),
      Math.round(buf.responseEndedAt),
    ),
    ...(buf.statusText ? { statusText: buf.statusText } : {}),
  };

  return {
    id: interactionId,
    capturedAt: new Date().toISOString(),
    inbound,
    dependencies: buf.dependencies,
    response,
  };
}

export async function readFetchBodies(
  request: Request,
  response: Response | null,
  pressure: PressureController,
  buf: CaptureBuffers,
): Promise<{ requestBody: Uint8Array; responseBody: Uint8Array }> {
  let requestBody = new Uint8Array();
  let responseBody = new Uint8Array();
  try {
    if (request.body) {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      if (reserveCaptureBytes(pressure, buf, bytes.byteLength)) {
        requestBody = bytes;
      }
    }
  } catch {
    // Fail-open: leave empty.
  }
  try {
    if (response) {
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      if (reserveCaptureBytes(pressure, buf, bytes.byteLength)) {
        responseBody = bytes;
      }
    }
  } catch {
    // Fail-open: leave empty.
  }
  return { requestBody, responseBody };
}
