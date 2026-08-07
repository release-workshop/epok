import { createHash } from "node:crypto";
import {
  StorageError,
  assertCasObjectIntegrity,
  assertManifestCasClosure,
  type CasKey,
  type PutManifestInput,
  type PutObjectResult,
  type StorageProvider,
} from "@epok/core";

function objectStoreKey(key: CasKey): string {
  return `${key.alg}:${key.hash}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Create an in-memory Storage Provider for tests and local experiments.
 * Not durable — do not use as production persistence.
 */
export function createMemoryStorageProvider(): StorageProvider {
  const objects = new Map<string, Uint8Array>();
  const manifests = new Map<string, Uint8Array>();

  const hasObject = async (key: CasKey): Promise<boolean> =>
    objects.has(objectStoreKey(key));

  return {
    durability: "best-effort",

    async putManifest(input: PutManifestInput): Promise<void> {
      await assertManifestCasClosure(input, hasObject, sha256Hex);
      manifests.set(input.id, input.bytes.slice());
    },

    async getManifest(id: string): Promise<Uint8Array> {
      const bytes = manifests.get(id);
      if (!bytes) {
        throw new StorageError("not_found", `manifest not found: ${id}`);
      }
      return bytes.slice();
    },

    async putObject(key: CasKey, bytes: Uint8Array): Promise<PutObjectResult> {
      assertCasObjectIntegrity(key, bytes, sha256Hex);
      const storeKey = objectStoreKey(key);
      if (objects.has(storeKey)) {
        return { created: false };
      }
      objects.set(storeKey, bytes.slice());
      return { created: true };
    },

    async getObject(key: CasKey): Promise<Uint8Array> {
      const bytes = objects.get(objectStoreKey(key));
      if (!bytes) {
        throw new StorageError(
          "not_found",
          `CAS object not found: ${key.alg}:${key.hash}`,
        );
      }
      return bytes.slice();
    },

    hasObject,
  };
}
