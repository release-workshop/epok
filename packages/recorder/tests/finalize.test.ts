import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REDACTION_SENTINEL,
  createSanitizer,
  type EmbeddedObject,
  type Sanitizer,
} from "@epok/core";
import {
  finalizeObservation,
  type ObservedCapture,
  type RecorderWideEvent,
} from "../src/index.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseCapture(
  overrides: Partial<ObservedCapture> = {},
): ObservedCapture {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    capturedAt: "2026-08-06T12:00:00.000Z",
    inbound: {
      protocol: "HTTP/1.1",
      method: "POST",
      url: "https://app.example/checkout?api_key=raw-secret&ok=1",
      headers: [
        { name: "Authorization", value: "Bearer raw-token" },
        { name: "Content-Type", value: "application/json" },
        { name: "X-Request-Id", value: "req-1" },
      ],
      body: new TextEncoder().encode(JSON.stringify({ amount: 10 })),
      contentType: "application/json",
    },
    dependencies: [
      {
        seq: 1,
        startedAt: 1,
        endedAt: 5,
        request: {
          protocol: "HTTP/1.1",
          method: "GET",
          url: "https://payments.example/charge?token=pay-secret",
          headers: [
            { name: "X-Api-Key", value: "pay-key" },
            { name: "Accept", value: "application/json" },
          ],
          body: new Uint8Array(),
          contentType: null,
        },
        response: {
          protocol: "HTTP/1.1",
          status: 200,
          headers: [{ name: "Content-Type", value: "application/json" }],
          body: new TextEncoder().encode(JSON.stringify({ ok: true })),
          contentType: "application/json",
        },
      },
    ],
    response: {
      protocol: "HTTP/1.1",
      status: 201,
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: new TextEncoder().encode(JSON.stringify({ id: "order-1" })),
      contentType: "application/json",
      startedAt: 6,
      endedAt: 7,
    },
    ...overrides,
  };
}

function decodeEmbedded(embedded: EmbeddedObject): Uint8Array {
  if (embedded.encoding === "utf-8") {
    return new TextEncoder().encode(embedded.data);
  }
  return Uint8Array.from(Buffer.from(embedded.data, "base64"));
}

describe("finalizeObservation", () => {
  it("builds a manifest that references only sanitized payload objects", () => {
    const rawAuth = "Bearer raw-token";
    const capture = baseCapture();
    const finalized = finalizeObservation(capture);

    expect(finalized).not.toBeNull();
    if (finalized === null) return;

    const { manifest, externalObjects } = finalized;

    expect(manifest.inbound.headers).toContainEqual({
      name: "Authorization",
      value: REDACTION_SENTINEL,
    });
    expect(manifest.inbound.headers).not.toContainEqual({
      name: "Authorization",
      value: rawAuth,
    });

    const inboundUrl = new URL(manifest.inbound.url);
    expect(inboundUrl.searchParams.get("api_key")).toBe(REDACTION_SENTINEL);
    expect(inboundUrl.searchParams.get("ok")).toBe("1");

    const dependency = manifest.dependencies[0];
    expect(dependency).toBeDefined();
    if (dependency === undefined) return;

    expect(dependency.request.headers).toContainEqual({
      name: "X-Api-Key",
      value: REDACTION_SENTINEL,
    });
    expect(new URL(dependency.request.url).searchParams.get("token")).toBe(
      REDACTION_SENTINEL,
    );

    const inboundBodyHash = manifest.inbound.body.cas.hash;
    const embedded = manifest.objects[inboundBodyHash];
    const inboundBytes = embedded
      ? decodeEmbedded(embedded)
      : externalObjects[inboundBodyHash];
    expect(inboundBytes).toBeDefined();
    if (inboundBytes === undefined) return;

    expect(sha256Hex(inboundBytes)).toBe(inboundBodyHash);
    const inboundText = new TextDecoder().decode(inboundBytes);
    expect(inboundText).not.toContain("raw-token");
    expect(inboundText).not.toContain("raw-secret");

    expect(manifest.metadata.sanitizer.version).toBeTruthy();
    expect(manifest.metadata.ruleset.id).toBe("epok.minimal");
    expect(manifest.integrity.objects.map((o) => o.hash)).toContain(
      inboundBodyHash,
    );
  });

  it("fail-opens by dropping the Interaction when sanitization throws", () => {
    const events: RecorderWideEvent[] = [];
    const throwingSanitizer: Sanitizer = {
      ...createSanitizer(),
      sanitize() {
        throw new Error("ruleset boom");
      },
    };

    const result = finalizeObservation(baseCapture(), {
      sanitizer: throwingSanitizer,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "interaction_dropped",
        reason: "sanitization_failed",
        interactionId: "01900000-0000-7000-8000-000000000001",
      }),
    );
  });

  it("fail-opens when a claimed JSON body cannot be sanitized", () => {
    const events: RecorderWideEvent[] = [];
    const capture = baseCapture({
      inbound: {
        protocol: "HTTP/1.1",
        method: "POST",
        url: "https://app.example/checkout",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: new TextEncoder().encode("{not-json"),
        contentType: "application/json",
      },
    });

    const result = finalizeObservation(capture, {
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "interaction_dropped",
        reason: "sanitization_failed",
      }),
    );
  });

  it("locks canonical integrity.manifestHash for a pinned capture (CAS integrity)", () => {
    const capture = baseCapture({
      recorder: { name: "@epok/recorder", version: "0.0.0" },
      runtime: { name: "node", version: "22.0.0" },
      captureMode: "full",
    });
    const finalized = finalizeObservation(capture);
    expect(finalized).not.toBeNull();
    if (finalized === null) return;
    expect(finalized.manifest.integrity.manifestHash).toBe(
      "c06c5bc1f1957170a040f147f257130254f1a050c6b5cdad56f97e223d9cacb9",
    );
  });

  it("canonicalizes object key order when hashing the manifest", () => {
    const capture = baseCapture({
      recorder: { name: "@epok/recorder", version: "0.0.0" },
      runtime: { name: "node", version: "22.0.0" },
      captureMode: "full",
    });
    const a = finalizeObservation(capture);
    const b = finalizeObservation({
      ...capture,
      recorder: { version: "0.0.0", name: "@epok/recorder" },
      runtime: { version: "22.0.0", name: "node" },
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;
    expect(b.manifest.integrity.manifestHash).toBe(
      a.manifest.integrity.manifestHash,
    );
  });
});
