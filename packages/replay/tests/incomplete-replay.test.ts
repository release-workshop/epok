import { describe, expect, it } from "vitest";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { mockReplay, runReplay, validateReplay } from "../src/index.js";
import { persistReplayFixtureWithDeps } from "./helpers.js";

describe("replay of Interactions with response null", () => {
  it("validateReplay still passes integrity for an incomplete Interaction", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixtureWithDeps(storage, {
      includeResponse: false,
      dependencies: [],
    });

    const result = await validateReplay({
      storage,
      interactionId: manifest.id,
    });

    expect(result.ok).toBe(true);
    expect(manifest.response).toBeNull();
  });

  it("runReplay refuses before execute when inbound response was not observed", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixtureWithDeps(storage, {
      includeResponse: false,
      dependencies: [],
    });
    let handlerCalls = 0;

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      handler: () => {
        handlerCalls += 1;
        return new Response("nope");
      },
    });

    expect(result.ok).toBe(false);
    expect(handlerCalls).toBe(0);
    expect(result.message).toMatch(/inbound response was not observed/i);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ code: "inbound_response_missing" }),
    ]);
  });

  it("mockReplay refuses when inbound response was not observed", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixtureWithDeps(storage, {
      includeResponse: false,
      dependencies: [],
    });

    const result = await mockReplay({
      storage,
      interactionId: manifest.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/inbound response was not observed/i);
    expect(result.playback).toBe("snapshot");
    expect(result.mismatches).toEqual([
      expect.objectContaining({ code: "inbound_response_missing" }),
    ]);
  });
});
