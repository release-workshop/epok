import type { StorageProvider } from "@epok/core";

/** Minimal Storage Provider stub — unused in observe-only slice. */
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
