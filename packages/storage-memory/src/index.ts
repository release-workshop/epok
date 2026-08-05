import type { StorageProvider } from "@epok/core";

/**
 * Create an in-memory Storage Provider for tests and local experiments.
 * Not durable — do not use as production persistence.
 * Implementation lands in the storage-provider slice; this export locks the seam.
 */
export function createMemoryStorageProvider(): StorageProvider {
  throw new Error(
    "@epok/storage-memory: createMemoryStorageProvider is not implemented yet",
  );
}
