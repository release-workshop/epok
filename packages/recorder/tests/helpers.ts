import type { StorageProvider } from "@epok/core";

/** Minimal Storage Provider stub — unused in observe-only assertions. */
export function unusedStorage(): StorageProvider {
  return {
    durability: "best-effort",
    putManifest: async () => {
      throw new Error("storage unused in observe-only");
    },
    getManifest: async () => {
      throw new Error("storage unused in observe-only");
    },
    putObject: async () => {
      throw new Error("storage unused in observe-only");
    },
    getObject: async () => {
      throw new Error("storage unused in observe-only");
    },
    hasObject: async () => {
      throw new Error("storage unused in observe-only");
    },
  };
}

/** Storage Provider that delays every put to force queue backlog under load. */
export function slowStorage(delayMs: number): StorageProvider {
  const manifests = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();

  async function delay(): Promise<void> {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    durability: "best-effort",
    async putManifest(input) {
      await delay();
      manifests.set(input.id, input.bytes);
    },
    async getManifest(id) {
      const bytes = manifests.get(id);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async putObject(key, bytes) {
      await delay();
      const existed = objects.has(key.hash);
      objects.set(key.hash, bytes);
      return { created: !existed };
    },
    async getObject(key) {
      const bytes = objects.get(key.hash);
      if (!bytes) throw new Error("not found");
      return bytes;
    },
    async hasObject(key) {
      return objects.has(key.hash);
    },
  };
}
