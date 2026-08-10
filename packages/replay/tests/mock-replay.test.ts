import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { mockReplay } from "../src/index.js";
import {
  persistReplayFixture,
  persistReplayFixtureWithDeps,
} from "./helpers.js";

describe("mockReplay", () => {
  it("serves recorded dependency fixtures without re-driving a handler", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);
    let networkHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      networkHits += 1;
      return originalFetch(...args);
    };

    try {
      const ready = await mockReplay({
        storage,
        interactionId: manifest.id,
      });

      expect(ready.ok).toBe(true);
      if (!ready.ok) return;

      expect(ready.playback).toBe("snapshot");
      expect(ready.inbound.url).toBe(manifest.inbound.url);
      expect(ready.recordedResponse.status).toBe(manifest.response.status);

      const injection = ready.installFetch();
      try {
        const dep = await fetch("https://api.example/quote");
        const payload = (await dep.json()) as { quote: number };
        expect(payload.quote).toBe(42);
        expect(networkHits).toBe(0);
      } finally {
        injection.restore();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not require a handler and leaves the recorded response as a fixture", async () => {
    const storage = createMemoryStorageProvider();
    const appBody = new TextEncoder().encode(JSON.stringify({ total: 99 }));
    const manifest = await persistReplayFixture(storage, {
      appResponseBody: appBody,
      appResponseStatus: 201,
    });

    const ready = await mockReplay({
      storage,
      interactionId: manifest.id,
    });

    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    expect(ready.recordedResponse.status).toBe(201);
    expect(await ready.recordedResponse.json()).toEqual({ total: 99 });
    // Snapshot mode never compares an executed handler response.
    expect(ready.message).toMatch(/snapshot|fixture|mock/i);
  });

  it("uses hybrid signature matching for dependency fixtures", async () => {
    const storage = createMemoryStorageProvider();
    const bodyA = new TextEncoder().encode(JSON.stringify({ kind: "a" }));
    const bodyB = new TextEncoder().encode(JSON.stringify({ kind: "b" }));
    const hashA = createHash("sha256").update(bodyA).digest("hex");

    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "POST",
          url: "https://api.example/pay",
          responseBody: new TextEncoder().encode(JSON.stringify({ ok: "a" })),
          requestHeaders: [{ name: "Content-Type", value: "application/json" }],
          requestBody: bodyA,
        },
        {
          seq: 2,
          method: "POST",
          url: "https://api.example/pay",
          responseBody: new TextEncoder().encode(JSON.stringify({ ok: "b" })),
          requestHeaders: [{ name: "Content-Type", value: "text/plain" }],
          requestBody: bodyB,
        },
      ],
      appResponseBody: new TextEncoder().encode("{}"),
    });

    const ready = await mockReplay({
      storage,
      interactionId: manifest.id,
    });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const injection = ready.installFetch();
    try {
      const response = await fetch("https://api.example/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyA,
      });
      expect(await response.json()).toEqual({ ok: "a" });
      expect(hashA).toHaveLength(64);
    } finally {
      injection.restore();
    }
  });

  it("realtime timing paces snapshot dependency injection", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/quote",
          responseBody: new TextEncoder().encode(JSON.stringify({ quote: 1 })),
          startedAt: 0,
          endedAt: 35,
        },
      ],
      appResponseBody: new TextEncoder().encode("{}"),
    });

    const ready = await mockReplay({
      storage,
      interactionId: manifest.id,
      timing: "realtime",
    });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.timing).toBe("realtime");

    const injection = ready.installFetch();
    try {
      const t0 = performance.now();
      const response = await fetch("https://api.example/quote");
      expect(performance.now() - t0).toBeGreaterThanOrEqual(30);
      expect(await response.json()).toEqual({ quote: 1 });
    } finally {
      injection.restore();
    }
  });
});
