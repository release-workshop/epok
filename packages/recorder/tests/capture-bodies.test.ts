import { describe, expect, it } from "vitest";
import {
  beginBodyRead,
  captureDependency,
  captureInboundRequestBody,
  captureInboundResponseBody,
  createCaptureBuffers,
  endBodyRead,
  waitForBodyReads,
} from "../src/capture.js";
import type { ObservedDependency } from "../src/finalize.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
} from "../src/pressure.js";

function pressure(maxBufferedBytes = 16 * 1024 * 1024): PressureController {
  return new PressureController(
    { ...DEFAULT_PRESSURE_LIMITS, maxBufferedBytes },
    undefined,
  );
}

function depRow(): ObservedDependency {
  return {
    seq: 1,
    startedAt: 0,
    endedAt: 0,
    networkReturned: true,
    request: {
      protocol: "HTTP/1.1",
      method: "GET",
      url: "http://example.test/dep",
      headers: [],
      body: new Uint8Array(),
    },
    response: null,
  };
}

describe("captureInboundRequestBody", () => {
  it("no-ops for Fetch GET without a framed body", () => {
    const buf = createCaptureBuffers();
    const p = pressure();
    captureInboundRequestBody(
      buf,
      p,
      new Request("http://example.test/", { method: "GET" }),
    );
    expect(buf.pendingBodyReads).toBe(0);
    expect(buf.inboundBody.byteLength).toBe(0);
    expect(buf.bodiesElided).toBe(false);
  });

  it("elides Fetch inbound when Content-Length exceeds the byte budget", async () => {
    const buf = createCaptureBuffers();
    buf.interactionId = "i1";
    const p = pressure(8);
    const body = "x".repeat(64);
    const request = new Request("http://example.test/", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": String(body.length),
      },
      body,
    });

    captureInboundRequestBody(buf, p, request);
    await waitForBodyReads(buf);

    expect(buf.bodiesElided).toBe(true);
    expect(buf.inboundBody.byteLength).toBe(0);
    expect(p.elided).toBeGreaterThan(0);
  });

  it("captures Fetch inbound body bytes under budget", async () => {
    const buf = createCaptureBuffers();
    const p = pressure();
    const payload = JSON.stringify({ amount: 42 });
    const request = new Request("http://example.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    captureInboundRequestBody(buf, p, request);
    await waitForBodyReads(buf);

    expect(buf.bodiesElided).toBe(false);
    expect(new TextDecoder().decode(buf.inboundBody)).toBe(payload);
  });
});

describe("captureInboundResponseBody", () => {
  it("elides Fetch response when Content-Length exceeds the byte budget", async () => {
    const buf = createCaptureBuffers();
    buf.interactionId = "i1";
    const p = pressure(8);
    const payload = "y".repeat(64);
    const upstream = new Response(payload, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(payload.length),
      },
    });

    const app = captureInboundResponseBody(buf, p, upstream);
    await waitForBodyReads(buf);

    expect(app).toBe(upstream);
    expect(buf.statusCode).toBe(200);
    expect(buf.inboundTerminalObserved).toBe(true);
    expect(buf.bodiesElided).toBe(true);
    expect(buf.responseBody.byteLength).toBe(0);
  });

  it("tees Fetch response so app and capture share one pull", async () => {
    const buf = createCaptureBuffers();
    const p = pressure();
    let pulls = 0;
    const payload = new TextEncoder().encode("resp-bytes");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(payload);
          return;
        }
        controller.close();
      },
    });
    const upstream = new Response(source, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
    });

    const app = captureInboundResponseBody(buf, p, upstream);
    const [appText] = await Promise.all([app.text(), waitForBodyReads(buf)]);

    expect(appText).toBe("resp-bytes");
    expect(new TextDecoder().decode(buf.responseBody)).toBe("resp-bytes");
    expect(buf.statusCode).toBe(200);
    expect(pulls).toBe(2);
  });
});

describe("captureDependency", () => {
  it("returns the upstream response and skips bodies when Content-Length exceeds budget", async () => {
    const buf = createCaptureBuffers();
    buf.interactionId = "i1";
    const p = pressure(8);
    const row = depRow();
    buf.dependencies.push(row);
    const payload = "z".repeat(64);
    const upstream = new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    });

    const app = captureDependency({
      row,
      buf,
      pressure: p,
      fetchInput: "http://example.test/dep",
      response: upstream,
    });
    await waitForBodyReads(buf);

    expect(app).toBe(upstream);
    expect(row.response).not.toBeNull();
    expect(row.response?.body.byteLength).toBe(0);
    expect(buf.bodiesElided).toBe(true);
  });

  it("captures dependency response bytes while the app also reads the body", async () => {
    const buf = createCaptureBuffers();
    const p = pressure();
    const row = depRow();
    buf.dependencies.push(row);
    const payload = "dependency-payload";
    const upstream = new Response(payload, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const app = captureDependency({
      row,
      buf,
      pressure: p,
      fetchInput: "http://example.test/dep",
      response: upstream,
    });
    const [appText] = await Promise.all([app.text(), waitForBodyReads(buf)]);

    expect(appText).toBe(payload);
    expect(row.response).not.toBeNull();
    if (row.response === null) return;
    expect(new TextDecoder().decode(row.response.body)).toBe(payload);
  });

  it("captures a buffered outbound request body", async () => {
    const buf = createCaptureBuffers();
    const p = pressure();
    const row = depRow();
    buf.dependencies.push(row);
    const requestPayload = JSON.stringify({ sku: "abc" });
    const upstream = new Response("ok", { status: 200 });

    captureDependency({
      row,
      buf,
      pressure: p,
      fetchInput: "http://example.test/dep",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestPayload,
      },
      response: upstream,
    });
    await waitForBodyReads(buf);

    expect(new TextDecoder().decode(row.request.body)).toBe(requestPayload);
  });
});

describe("waitForBodyReads coordination", () => {
  it("resolves after begin/end pairing", async () => {
    const buf = createCaptureBuffers();
    beginBodyRead(buf);
    const done = waitForBodyReads(buf);
    endBodyRead(buf);
    await done;
    expect(buf.pendingBodyReads).toBe(0);
  });
});
