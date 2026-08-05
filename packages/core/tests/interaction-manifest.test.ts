import { describe, expect, it } from "vitest";
import type { InteractionManifest } from "../src/index.js";
import { SPEC_VERSION } from "../src/index.js";

describe("Interaction manifest contract", () => {
  it("accepts a minimal finalized Interaction shaped per the Interaction spec", () => {
    const manifest: InteractionManifest = {
      id: "018f6b3f-32f2-7f9a-b66d-1f7a26134f0c",
      specVersion: SPEC_VERSION,
      metadata: {
        capturedAt: "2026-08-05T12:00:00.000Z",
        recorder: { name: "@epok/recorder", version: "0.0.0" },
        runtime: { name: "node", version: "24.12.0" },
        sanitizer: { version: "0.0.0" },
        ruleset: { id: "epok-minimal", hash: "a".repeat(64) },
        captureMode: "full",
      },
      inbound: {
        protocol: "HTTP/1.1",
        method: "GET",
        url: "https://example.test/hello",
        headers: [{ name: "host", value: "example.test" }],
        body: {
          cas: {
            alg: "sha256",
            hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            size: 0,
            contentType: null,
            contentEncoding: null,
          },
        },
      },
      dependencies: [],
      response: {
        protocol: "HTTP/1.1",
        status: 200,
        statusText: "OK",
        headers: [{ name: "content-type", value: "text/plain" }],
        body: {
          cas: {
            alg: "sha256",
            hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            size: 0,
            contentType: "text/plain",
            contentEncoding: null,
          },
        },
        startedAt: 0,
        endedAt: 1,
      },
      replay: { signatures: [] },
      objects: {},
      integrity: {
        manifestHash: "b".repeat(64),
        objects: [
          {
            alg: "sha256",
            hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            size: 0,
          },
        ],
      },
    };

    expect(manifest.specVersion).toBe("1.0.0");
    expect(manifest.dependencies).toEqual([]);
  });
});
