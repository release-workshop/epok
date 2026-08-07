import { describe, expect, it } from "vitest";
import { StorageError, type StorageProvider } from "@epok/core";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { validateReplay, type ReplayResult } from "../src/index.js";
import { persistReplayFixture, sha256Hex } from "./helpers.js";

describe("validateReplay", () => {
  it("passes integrity checks for a persisted Interaction", async () => {
    const storage = createMemoryStorageProvider();
    const manifest = await persistReplayFixture(storage);

    const result = await validateReplay({
      storage,
      interactionId: manifest.id,
    });

    expect(result.ok).toBe(true);
    expect(result.interactionId).toBe(manifest.id);
  });

  it("fails when a required CAS object is missing", async () => {
    const storage = createMemoryStorageProvider();
    const valid = await persistReplayFixture(storage);
    const orphanHash = sha256Hex(new TextEncoder().encode("absent"));
    const tampered = structuredClone(valid);
    tampered.integrity.objects.push({
      alg: "sha256",
      hash: orphanHash,
      size: 6,
    });

    const provider: StorageProvider = {
      durability: "best-effort",
      putManifest: async () => undefined,
      getManifest: async () =>
        new TextEncoder().encode(JSON.stringify(tampered)),
      putObject: async () => ({ created: true }),
      getObject: async (key) => {
        throw new StorageError(
          "not_found",
          `CAS object not found: ${key.alg}:${key.hash}`,
        );
      },
      hasObject: async () => false,
    };

    const result = await validateReplay({
      storage: provider,
      interactionId: tampered.id,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found|CAS/i);
  });
});

describe("ReplayResult shape", () => {
  it("remains hospitable to future timing and signature enrichment fields", () => {
    const result: ReplayResult = {
      ok: true,
      interactionId: "01900000-0000-7000-8000-000000000011",
      message: "ok",
      timing: "instant",
      mode: "strict",
      timingNotes: [],
      signatureOutcomes: [{ secretRef: "payments", ok: true }],
    };
    expect(result.timingNotes).toEqual([]);
    expect(result.signatureOutcomes?.[0]?.secretRef).toBe("payments");
  });
});
