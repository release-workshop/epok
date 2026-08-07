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
});
