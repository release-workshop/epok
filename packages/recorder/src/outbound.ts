import type { RecorderObservationHooks } from "@epok/core";
import {
  captureDependency,
  headersToFields,
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

    return captureDependency({
      row,
      buf,
      pressure,
      fetchInput: input,
      init,
      response,
    });
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
