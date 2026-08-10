import { describe, expect, it } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { runReplay } from "../src/index.js";
import {
  persistReplayFixture,
  persistReplayFixtureWithDeps,
} from "./helpers.js";

describe("runReplay", () => {
  it("reproduces the recorded response without reaching the dependency network", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);
    let networkHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      networkHits += 1;
      return originalFetch(...args);
    };

    try {
      const result = await runReplay({
        storage,
        interactionId: manifest.id,
        handler: async () => {
          const dep = await fetch("https://api.example/quote");
          const payload = (await dep.json()) as { quote: number };
          return Response.json({ total: payload.quote });
        },
      });

      expect(result.ok).toBe(true);
      expect(result.interactionId).toBe(manifest.id);
      expect(networkHits).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an actionable validation failure on strict dependency mismatch", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      handler: async () => {
        await fetch("https://api.example/wrong-path");
        return Response.json({ total: 0 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        method: "GET",
        url: "https://api.example/wrong-path",
      }),
    ]);
    expect(result.message).toMatch(/no recorded dependency/i);
    expect(result.message).toContain("https://api.example/wrong-path");
  });

  it("disambiguates identical method+URL retries by recorded seq order", async () => {
    const storage = createMemoryStorageProvider();
    const firstBody = new TextEncoder().encode(JSON.stringify({ n: 1 }));
    const secondBody = new TextEncoder().encode(JSON.stringify({ n: 2 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ sum: 3 }));

    // Build a fixture with two identical dependency keys.
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/retry",
          responseBody: firstBody,
        },
        {
          seq: 2,
          method: "GET",
          url: "https://api.example/retry",
          responseBody: secondBody,
        },
      ],
      appResponseBody: appBody,
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      handler: async () => {
        const a = (await (await fetch("https://api.example/retry")).json()) as {
          n: number;
        };
        const b = (await (await fetch("https://api.example/retry")).json()) as {
          n: number;
        };
        return Response.json({ sum: a.n + b.n });
      },
    });

    expect(result.ok).toBe(true);
  });

  it("diagnostic-lenient relaxes dependency URL match and never reports deterministic success", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage, {
      dependencyUrl: "https://api.example/quote",
      dependencyResponseBody: new TextEncoder().encode(
        JSON.stringify({ quote: 42 }),
      ),
      appResponseBody: new TextEncoder().encode(JSON.stringify({ total: 42 })),
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "diagnostic-lenient",
      handler: async () => {
        const dep = await fetch("https://api.example/quote-v2");
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ total: payload.quote });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("diagnostic-lenient");
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        method: "GET",
        url: "https://api.example/quote-v2",
        dependencySeq: 1,
      }),
    ]);
    expect(result.message).toMatch(/diagnostic/i);
    expect(result.mismatches?.[0]?.message).toContain(
      "https://api.example/quote",
    );
  });

  it("diagnostic-lenient collects status and body mismatches without stopping at the first", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage, {
      appResponseStatus: 200,
      appResponseBody: new TextEncoder().encode(JSON.stringify({ total: 42 })),
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "diagnostic-lenient",
      handler: async () => {
        await fetch("https://api.example/quote");
        return new Response(JSON.stringify({ total: 99 }), { status: 500 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("diagnostic-lenient");
    expect(result.mismatches).toEqual([
      expect.objectContaining({ code: "response_status_mismatch" }),
      expect.objectContaining({ code: "response_body_mismatch" }),
    ]);
    expect(result.message).toMatch(/diagnostic-lenient replay found 2/i);
  });

  it("diagnostic-lenient still fails hard when no same-method dependency exists", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "diagnostic-lenient",
      handler: async () => {
        await fetch("https://api.example/quote", { method: "POST" });
        return Response.json({ total: 0 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        method: "POST",
        url: "https://api.example/quote",
      }),
    ]);
    expect(result.message).toMatch(/no recorded dependency/i);
  });

  it("diagnostic-lenient hard-fails even when the handler catches the inject throw", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "diagnostic-lenient",
      handler: async () => {
        try {
          await fetch("https://api.example/quote", { method: "POST" });
        } catch {
          // ignore inject throw
        }
        return Response.json({ total: 42 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        method: "POST",
      }),
    ]);
    expect(result.message).toMatch(/no recorded dependency/i);
  });

  it("diagnostic-lenient keeps soft mismatch diagnostics when the handler later throws", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "diagnostic-lenient",
      handler: async () => {
        await fetch("https://api.example/quote-v2");
        throw new Error("boom after soft match");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("boom after soft match");
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        url: "https://api.example/quote-v2",
        dependencySeq: 1,
      }),
      expect.objectContaining({
        code: "handler_error",
        message: "boom after soft match",
      }),
    ]);
  });

  it("strict mode still fails on the first response mismatch only", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage, {
      appResponseStatus: 200,
      appResponseBody: new TextEncoder().encode(JSON.stringify({ total: 42 })),
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      mode: "strict",
      handler: async () => {
        await fetch("https://api.example/quote");
        return new Response(JSON.stringify({ total: 99 }), { status: 500 });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("strict");
    expect(result.mismatches).toEqual([
      expect.objectContaining({ code: "response_status_mismatch" }),
    ]);
  });

  it("realtime timing delays dependency completion by recorded duration", async () => {
    const storage = createMemoryStorageProvider();
    const depBody = new TextEncoder().encode(JSON.stringify({ quote: 42 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ total: 42 }));
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/quote",
          responseBody: depBody,
          startedAt: 0,
          endedAt: 40,
        },
      ],
      appResponseBody: appBody,
    });

    const t0 = performance.now();
    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      timing: "realtime",
      handler: async () => {
        const dep = await fetch("https://api.example/quote");
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(35);
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ total: payload.quote });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.timing).toBe("realtime");
  });

  it("realtime timing respects recorded endedAt relative to replay start", async () => {
    const storage = createMemoryStorageProvider();
    const depBody = new TextEncoder().encode(JSON.stringify({ quote: 7 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ total: 7 }));
    // Short duration (5ms) but late relative completion (50ms) — cadence uses endedAt.
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/quote",
          responseBody: depBody,
          startedAt: 45,
          endedAt: 50,
        },
      ],
      appResponseBody: appBody,
    });

    const t0 = performance.now();
    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      timing: "realtime",
      handler: async () => {
        const dep = await fetch("https://api.example/quote");
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(45);
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ total: payload.quote });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.timing).toBe("realtime");
  });

  it("realtime timing preserves relative cadence across multiple dependencies", async () => {
    const storage = createMemoryStorageProvider();
    const bodyA = new TextEncoder().encode(JSON.stringify({ n: 1 }));
    const bodyB = new TextEncoder().encode(JSON.stringify({ n: 2 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ sum: 3 }));
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/a",
          responseBody: bodyA,
          startedAt: 0,
          endedAt: 25,
        },
        {
          seq: 2,
          method: "GET",
          url: "https://api.example/b",
          responseBody: bodyB,
          startedAt: 25,
          endedAt: 55,
        },
      ],
      appResponseBody: appBody,
    });

    const t0 = performance.now();
    let firstDoneAt = 0;
    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      timing: "realtime",
      handler: async () => {
        const a = (await (await fetch("https://api.example/a")).json()) as {
          n: number;
        };
        firstDoneAt = performance.now() - t0;
        const b = (await (await fetch("https://api.example/b")).json()) as {
          n: number;
        };
        const secondDoneAt = performance.now() - t0;
        expect(firstDoneAt).toBeGreaterThanOrEqual(20);
        expect(secondDoneAt).toBeGreaterThanOrEqual(50);
        expect(secondDoneAt).toBeGreaterThanOrEqual(firstDoneAt);
        return Response.json({ sum: a.n + b.n });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.timing).toBe("realtime");
  });

  it("instant timing remains the default and does not pace dependency responses", async () => {
    const storage = createMemoryStorageProvider();
    const depBody = new TextEncoder().encode(JSON.stringify({ quote: 42 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ total: 42 }));
    const manifest = await persistReplayFixtureWithDeps(storage, {
      dependencies: [
        {
          seq: 1,
          method: "GET",
          url: "https://api.example/quote",
          responseBody: depBody,
          startedAt: 0,
          endedAt: 200,
        },
      ],
      appResponseBody: appBody,
    });

    const t0 = performance.now();
    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      handler: async () => {
        const dep = await fetch("https://api.example/quote");
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ total: payload.quote });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.timing).toBe("instant");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(result.timingNotes).toBeUndefined();
  });
});
