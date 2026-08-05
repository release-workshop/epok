import { describe, expect, it } from "vitest";
import type { StorageProvider } from "../src/index.js";
import { StorageError } from "../src/index.js";

/** Minimal in-process provider used only to prove the seam is implementable without Node APIs. */
function createMemoryProvider(): StorageProvider {
  const manifests = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();

  const objectKey = (alg: string, hash: string) => `${alg}:${hash}`;

  return {
    durability: "best-effort",
    async putManifest({ id, bytes }) {
      manifests.set(id, bytes);
    },
    async getManifest(id) {
      const bytes = manifests.get(id);
      if (!bytes) {
        throw new StorageError("not_found", `manifest ${id} not found`);
      }
      return bytes;
    },
    async putObject(key, bytes) {
      const k = objectKey(key.alg, key.hash);
      const created = !objects.has(k);
      if (created) {
        objects.set(k, bytes);
      }
      return { created };
    },
    async getObject(key) {
      const bytes = objects.get(objectKey(key.alg, key.hash));
      if (!bytes) {
        throw new StorageError("not_found", `object ${key.hash} not found`);
      }
      return bytes;
    },
    async hasObject(key) {
      return objects.has(objectKey(key.alg, key.hash));
    },
  };
}

describe("Storage Provider seam", () => {
  it("persists and retrieves a manifest plus CAS object by hash", async () => {
    const provider = createMemoryProvider();
    const manifestBytes = new TextEncoder().encode('{"id":"x"}');
    const objectBytes = new Uint8Array([1, 2, 3]);
    const key = {
      alg: "sha256" as const,
      hash: "c".repeat(64),
    };

    await provider.putObject(key, objectBytes);
    await provider.putManifest({
      id: "018f6b3f-32f2-7f9a-b66d-1f7a26134f0c",
      specVersion: "1.0.0",
      manifestHash: "d".repeat(64),
      bytes: manifestBytes,
    });

    expect(await provider.hasObject(key)).toBe(true);
    expect(await provider.getObject(key)).toEqual(objectBytes);
    expect(
      await provider.getManifest("018f6b3f-32f2-7f9a-b66d-1f7a26134f0c"),
    ).toEqual(manifestBytes);
  });

  it("surfaces typed not_found failures", async () => {
    const provider = createMemoryProvider();
    await expect(provider.getManifest("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
