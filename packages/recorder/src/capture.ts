import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeaderField, RuntimeIdentity } from "@epok/core";
import type { CaptureMode } from "./capture-mode.js";
import type {
  ObservedCapture,
  ObservedDependency,
  ObservedHttpRequest,
} from "./finalize.js";
import type { PressureController } from "./pressure.js";

/** Inbound HTTP metadata copied at settle entry — not live request objects. */
export interface InboundSnapshot {
  protocol: string;
  method: string;
  url: string;
  headers: HeaderField[];
  contentType: string | null;
}

export interface CaptureBuffers {
  inboundBody: Uint8Array;
  responseBody: Uint8Array;
  responseHeaders: HeaderField[];
  /** Observed inbound status; unset until headers/end are seen. */
  statusCode?: number;
  statusText: string;
  /** True once inbound terminal was observed (finish / end / headers sent). */
  inboundTerminalObserved: boolean;
  dependencies: ObservedDependency[];
  /** Monotonic ms from Interaction start. */
  startedAt: number;
  responseStartedAt: number;
  responseEndedAt: number;
  pendingBodyReads: number;
  reservedBytes: number;
  dropped: boolean;
  dropReason?: string;
  /** Bodies were discarded under byte-budget pressure; persist metadata only. */
  bodiesElided: boolean;
  /** Set when capture starts so elision events correlate to the Interaction. */
  interactionId?: string;
  /** Uncaught/terminal host failure (destroy/errored/sync throw). */
  terminalHostError: boolean;
  /** True after inbound terminal settle; outbound must not mutate rows. */
  frozen: boolean;
  bodyWaiters: Array<() => void>;
  /** Copied at settle entry so the persist job does not retain request objects. */
  inboundSnapshot?: InboundSnapshot;
  /** Runtime identity stamped at settle (Fetch adapters). */
  runtime?: RuntimeIdentity;
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
    statusText: "",
    inboundTerminalObserved: false,
    frozen: false,
    dependencies: [],
    startedAt: performance.now(),
    responseStartedAt: 0,
    responseEndedAt: 0,
    pendingBodyReads: 0,
    reservedBytes: 0,
    dropped: false,
    bodiesElided: false,
    terminalHostError: false,
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

/**
 * True when inbound body capture is worth installing: framed non-empty body
 * (Content-Length > 0 or Transfer-Encoding), or a method that commonly carries
 * a body even when framing headers are incomplete.
 */
function expectsInboundBody(req: IncomingMessage): boolean {
  if (hasFramedInboundBody(req)) return true;
  const method = (req.method ?? "GET").toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH";
}

function expectsFetchInboundBody(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    return true;
  }
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 0) return true;
  return request.headers.has("transfer-encoding");
}

function hasFramedInboundBody(req: IncomingMessage): boolean {
  const transferEncoding = headerValue(req.headers["transfer-encoding"]);
  if (transferEncoding !== undefined && transferEncoding.length > 0) {
    return true;
  }
  const contentLength = headerValue(req.headers["content-length"]);
  if (contentLength === undefined || contentLength === "") return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > 0;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function markDropped(buf: CaptureBuffers, reason: string): void {
  buf.dropped = true;
  buf.dropReason = reason;
}

/** Record that the inbound response terminal was observed (finish/end/headers). */
export function noteInboundTerminal(
  buf: CaptureBuffers,
  res: ServerResponse,
): void {
  if (buf.inboundTerminalObserved && buf.statusCode !== undefined) return;
  buf.inboundTerminalObserved = true;
  buf.statusCode = res.statusCode;
  buf.statusText = res.statusMessage || buf.statusText;
  if (buf.responseHeaders.length === 0) {
    buf.responseHeaders = headersToFields(
      res.getHeaders() as IncomingMessage["headers"],
    );
  }
  if (buf.responseEndedAt === 0) {
    buf.responseEndedAt = performance.now() - buf.startedAt;
  }
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
 * Freeze the capture at inbound terminal. In-flight fetches keep their
 * invoke-time row; later completion must not patch it.
 */
export function freezeCapture(buf: CaptureBuffers): void {
  if (buf.frozen) return;
  buf.frozen = true;
  const terminalAt = Math.max(
    0,
    Math.round(
      buf.responseEndedAt > 0
        ? buf.responseEndedAt
        : performance.now() - buf.startedAt,
    ),
  );
  for (const dep of buf.dependencies) {
    if (
      dep.response === null &&
      dep.error === undefined &&
      !dep.networkReturned
    ) {
      dep.endedAt = Math.max(dep.startedAt, terminalAt);
    }
  }
}

/**
 * Discard captured bodies and release their reserved bytes. The Interaction
 * stays eligible to persist with empty CAS bodies.
 */
function elideCaptureBodies(
  pressure: PressureController,
  buf: CaptureBuffers,
): void {
  if (buf.dropped || buf.bodiesElided) return;
  buf.bodiesElided = true;
  buf.inboundBody = new Uint8Array();
  buf.responseBody = new Uint8Array();
  for (const dep of buf.dependencies) {
    dep.request.body = new Uint8Array();
    if (dep.response) {
      dep.response.body = new Uint8Array();
    }
  }
  const released = buf.reservedBytes;
  releaseCaptureBytes(pressure, buf);
  pressure.recordBodyElision(released, buf.interactionId);
}

/** Skip body capture when this Interaction already elided or the byte budget is exhausted. */
function shouldSkipBodyCapture(
  pressure: PressureController,
  buf: CaptureBuffers,
): boolean {
  return buf.dropped || buf.bodiesElided || pressure.shouldElideBodies;
}

/** Elide if skip is already required. Returns true when body capture should stop. */
function skipOrElideBodies(
  pressure: PressureController,
  buf: CaptureBuffers,
): boolean {
  if (!shouldSkipBodyCapture(pressure, buf)) return false;
  elideCaptureBodies(pressure, buf);
  return true;
}

/**
 * Elide before pulling a body whose known size would exceed the byte budget.
 * Returns true when the caller should skip expensive body work.
 */
function skipOrElideKnownSize(
  pressure: PressureController,
  buf: CaptureBuffers,
  byteLength: number,
): boolean {
  if (skipOrElideBodies(pressure, buf)) return true;
  if (
    pressure.limits.bodyElision &&
    pressure.wouldExceedByteBudget(byteLength)
  ) {
    elideCaptureBodies(pressure, buf);
    return true;
  }
  return false;
}

function contentLengthBytes(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null || raw === "") return undefined;
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) return undefined;
  return length;
}

/** Skip body work when Content-Length is known to exceed the remaining budget. */
function skipOrElideContentLength(
  pressure: PressureController,
  buf: CaptureBuffers,
  headers: Headers,
): boolean {
  const length = contentLengthBytes(headers);
  if (length === undefined) return skipOrElideBodies(pressure, buf);
  return skipOrElideKnownSize(pressure, buf, length);
}

/** Node inbound variant using IncomingMessage headers. */
function skipOrElideNodeContentLength(
  pressure: PressureController,
  buf: CaptureBuffers,
  req: IncomingMessage,
): boolean {
  const raw = headerValue(req.headers["content-length"]);
  if (raw === undefined || raw === "") {
    return skipOrElideBodies(pressure, buf);
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) {
    return skipOrElideBodies(pressure, buf);
  }
  return skipOrElideKnownSize(pressure, buf, length);
}

/** Skip when a buffered BodyInit size is known to exceed the remaining budget. */
function skipOrElideBufferedBodyInit(
  pressure: PressureController,
  buf: CaptureBuffers,
  body: BodyInit | null | undefined,
): boolean {
  const buffered = readBufferedBodyInit(body);
  if (buffered === null) return skipOrElideBodies(pressure, buf);
  return skipOrElideKnownSize(pressure, buf, buffered.byteLength);
}

/**
 * Reserve buffered bytes under the global budget. On failure, elide bodies
 * (default) or mark the Interaction dropped when body elision is disabled.
 */
export function reserveCaptureBytes(
  pressure: PressureController,
  buf: CaptureBuffers,
  bytes: number,
): boolean {
  if (buf.dropped || buf.bodiesElided) return false;
  if (!pressure.tryReserveBytes(bytes)) {
    if (pressure.limits.bodyElision) {
      elideCaptureBodies(pressure, buf);
      return false;
    }
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

function tryCaptureChunk(
  sink: {
    buf: CaptureBuffers;
    pressure: PressureController;
    chunks: Buffer[];
  },
  chunk: unknown,
  encoding?: BufferEncoding,
): void {
  const { buf, pressure, chunks } = sink;
  if (buf.bodiesElided || buf.dropped) return;
  const bufChunk = chunkToBuffer(chunk, encoding);
  if (bufChunk && reserveCaptureBytes(pressure, buf, bufChunk.byteLength)) {
    chunks.push(bufChunk);
  }
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
function installResponseCapture(
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
      tryCaptureChunk(
        { buf, pressure, chunks },
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
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
      tryCaptureChunk(
        { buf, pressure, chunks },
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
      buf.responseBody = buf.bodiesElided
        ? new Uint8Array()
        : Buffer.concat(chunks);
      buf.statusCode = res.statusCode;
      buf.statusText = res.statusMessage || "";
      buf.responseHeaders = headersToFields(
        res.getHeaders() as IncomingMessage["headers"],
      );
      buf.responseEndedAt = performance.now() - buf.startedAt;
      buf.inboundTerminalObserved = true;
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
function installInboundBodyCapture(
  req: IncomingMessage,
  buf: CaptureBuffers,
  pressure: PressureController,
): void {
  const chunks: Buffer[] = [];
  const originalPush = req.push.bind(req);
  req.push = (chunk: unknown, encoding?: BufferEncoding) => {
    try {
      if (chunk) {
        tryCaptureChunk({ buf, pressure, chunks }, chunk, encoding);
      } else {
        buf.inboundBody = buf.bodiesElided
          ? new Uint8Array()
          : Buffer.concat(chunks);
      }
    } catch {
      // Fail-open.
    }
    return originalPush(chunk, encoding);
  };
}

export function inboundSnapshotFromNode(req: IncomingMessage): InboundSnapshot {
  return {
    protocol: `HTTP/${req.httpVersion}`,
    method: req.method ?? "GET",
    url: nodeRequestUrl(req),
    headers: headersToFields(req.headers),
    contentType:
      typeof req.headers["content-type"] === "string"
        ? req.headers["content-type"]
        : null,
  };
}

export function buildObservedCapture(
  interactionId: string,
  buf: CaptureBuffers,
  captureMode?: CaptureMode,
): ObservedCapture | null {
  const snap = buf.inboundSnapshot;
  if (snap === undefined) return null;

  const inbound: ObservedHttpRequest = {
    protocol: snap.protocol,
    method: snap.method,
    url: snap.url,
    headers: snap.headers,
    body: buf.inboundBody,
    contentType: snap.contentType,
  };

  const response =
    buf.inboundTerminalObserved && buf.statusCode !== undefined
      ? {
          protocol: snap.protocol,
          status: buf.statusCode,
          headers: buf.responseHeaders,
          body: buf.responseBody,
          contentType:
            buf.responseHeaders.find(
              (h) => h.name.toLowerCase() === "content-type",
            )?.value ?? null,
          startedAt: Math.max(0, Math.round(buf.responseStartedAt)),
          endedAt: Math.max(
            Math.round(buf.responseStartedAt),
            Math.round(buf.responseEndedAt),
          ),
          ...(buf.statusText ? { statusText: buf.statusText } : {}),
        }
      : null;

  return {
    id: interactionId,
    capturedAt: new Date().toISOString(),
    inbound,
    dependencies: buf.dependencies,
    response,
    ...(captureMode !== undefined ? { captureMode } : {}),
    ...(buf.runtime !== undefined ? { runtime: buf.runtime } : {}),
  };
}

/**
 * Extract bytes from a buffered BodyInit without cloning a stream.
 * Returns `null` when omitted or streaming (caller may try another source).
 */
function readBufferedBodyInit(
  body: BodyInit | null | undefined,
): Uint8Array | null {
  if (body === undefined) return null;
  if (body === null) return new Uint8Array();
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}

/**
 * Tee a fetch Response body so the app and capture each get a branch from a
 * single underlying pull (no parallel `clone().arrayBuffer()`). Fail-open:
 * on tee failure, return the original response and an empty capture body.
 */
function teeFetchResponseBody(response: Response): {
  response: Response;
  captureBody: Promise<Uint8Array>;
} {
  const body = response.body;
  if (!body) {
    return { response, captureBody: Promise.resolve(new Uint8Array()) };
  }
  try {
    const [appBranch, captureBranch] = body.tee();
    const captureBody: Promise<Uint8Array> = new Response(captureBranch)
      .arrayBuffer()
      .then((buf) => {
        const bytes = new Uint8Array(buf.byteLength);
        bytes.set(new Uint8Array(buf));
        return bytes;
      })
      .catch(() => new Uint8Array());
    const appResponse = new Response(appBranch, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Response constructor leaves url/redirected empty; restore from upstream.
    try {
      Object.defineProperty(appResponse, "url", { value: response.url });
      Object.defineProperty(appResponse, "redirected", {
        value: response.redirected,
      });
    } catch {
      // Best-effort; body tee still succeeds.
    }
    return {
      response: appResponse,
      captureBody,
    };
  } catch {
    return { response, captureBody: Promise.resolve(new Uint8Array()) };
  }
}

/** Reserve captured body bytes under pressure; empty on budget failure. */
function takeCapturedBytes(
  pressure: PressureController,
  buf: CaptureBuffers,
  bytes: Uint8Array,
): Uint8Array {
  if (bytes.byteLength === 0) return bytes;
  if (!reserveCaptureBytes(pressure, buf, bytes.byteLength)) {
    return new Uint8Array();
  }
  return bytes;
}

function isFetchRequest(source: IncomingMessage | Request): source is Request {
  return typeof Request !== "undefined" && source instanceof Request;
}

function isNodeServerResponse(
  source: ServerResponse | Response,
): source is ServerResponse {
  return (
    typeof (source as ServerResponse).write === "function" &&
    typeof (source as ServerResponse).end === "function"
  );
}

/**
 * Decide-and-attach inbound request body capture. No-ops when no body is
 * expected, already elided/dropped, or Content-Length exceeds the budget.
 */
export function captureInboundRequestBody(
  buf: CaptureBuffers,
  pressure: PressureController,
  source: IncomingMessage | Request,
): void {
  if (isFetchRequest(source)) {
    if (!expectsFetchInboundBody(source)) return;
    if (skipOrElideContentLength(pressure, buf, source.headers)) return;
    beginBodyRead(buf);
    void (async () => {
      try {
        const body = source.body;
        if (!body) {
          buf.inboundBody = new Uint8Array();
          return;
        }
        const bytes = new Uint8Array(await source.clone().arrayBuffer());
        buf.inboundBody = takeCapturedBytes(pressure, buf, bytes);
      } catch {
        // Fail-open.
      } finally {
        endBodyRead(buf);
      }
    })();
    return;
  }

  if (!expectsInboundBody(source)) return;
  if (skipOrElideNodeContentLength(pressure, buf, source)) return;
  installInboundBodyCapture(source, buf, pressure);
}

/**
 * Decide-and-attach inbound response body capture.
 * Node: wrap write/end. Fetch: stamp terminal metadata and tee (or elide).
 */
export function captureInboundResponseBody(
  buf: CaptureBuffers,
  pressure: PressureController,
  source: ServerResponse,
): void;
export function captureInboundResponseBody(
  buf: CaptureBuffers,
  pressure: PressureController,
  source: Response,
): Response;
export function captureInboundResponseBody(
  buf: CaptureBuffers,
  pressure: PressureController,
  source: ServerResponse | Response,
): void | Response {
  if (isNodeServerResponse(source)) {
    installResponseCapture(source, buf, pressure);
    return;
  }

  buf.statusCode = source.status;
  buf.statusText = source.statusText;
  buf.inboundTerminalObserved = true;
  buf.responseHeaders = headersToFields(source.headers);
  if (buf.responseStartedAt === 0) {
    buf.responseStartedAt = performance.now() - buf.startedAt;
  }
  if (skipOrElideContentLength(pressure, buf, source.headers)) {
    buf.responseBody = new Uint8Array();
    buf.responseEndedAt = performance.now() - buf.startedAt;
    return source;
  }
  beginBodyRead(buf);
  const teed = teeFetchResponseBody(source);
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

/**
 * After a Dependency network return: elide or capture request/response bodies.
 * Returns the app-visible Response (possibly teed).
 */
export function captureDependency(input: {
  row: ObservedDependency;
  buf: CaptureBuffers;
  pressure: PressureController;
  fetchInput: RequestInfo | URL;
  init?: RequestInit;
  response: Response;
}): Response {
  const { row, buf, pressure, fetchInput, init, response } = input;
  if (
    skipOrElideBufferedBodyInit(pressure, buf, init?.body) ||
    skipOrElideContentLength(pressure, buf, response.headers)
  ) {
    finishDependencyWithoutBodies({ row, buf, fetchInput, init, response });
    return response;
  }
  return scheduleDependencyCapture({
    row,
    buf,
    fetchInput,
    init,
    response,
    pressure,
  });
}

function scheduleDependencyCapture(input: {
  row: ObservedDependency;
  buf: CaptureBuffers;
  fetchInput: RequestInfo | URL;
  init?: RequestInit;
  response: Response;
  pressure: PressureController;
}): Response {
  const { row, buf, fetchInput, init, response, pressure } = input;
  beginBodyRead(buf);
  const teed = teeFetchResponseBody(response);
  const appResponse = teed.response;
  const captureBody = teed.captureBody;

  void (async () => {
    try {
      const request = new Request(fetchInput, init);
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
    const fromInit = readOutboundBodyFromInit(init, pressure, buf);
    if (fromInit !== undefined) return fromInit;
    return await readOutboundBodyFromRequest(request, pressure, buf);
  } catch {
    return new Uint8Array();
  }
}

/** `undefined` means init had no buffered body — try the Request stream. */
function readOutboundBodyFromInit(
  init: RequestInit | undefined,
  pressure: PressureController,
  buf: CaptureBuffers,
): Uint8Array | undefined {
  const buffered = readBufferedBodyInit(init?.body);
  if (buffered === null) return undefined;
  if (skipOrElideKnownSize(pressure, buf, buffered.byteLength)) {
    return new Uint8Array();
  }
  return takeCapturedBytes(pressure, buf, buffered);
}

async function readOutboundBodyFromRequest(
  request: Request,
  pressure: PressureController,
  buf: CaptureBuffers,
): Promise<Uint8Array> {
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
}

function finishDependencyWithoutBodies(input: {
  row: ObservedDependency;
  buf: CaptureBuffers;
  fetchInput: RequestInfo | URL;
  init?: RequestInit;
  response: Response;
}): void {
  const { row, buf, fetchInput, init, response } = input;
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
