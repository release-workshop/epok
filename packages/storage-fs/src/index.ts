import type { StorageProvider } from "@epok/core";

export interface FsStorageProviderOptions {
  /** Directory root for manifests and CAS objects. */
  rootDir: string;
}

/**
 * Create a durable filesystem Storage Provider.
 * Implementation lands in the storage-provider slice; this export locks the seam.
 */
export function createFsStorageProvider(
  _options: FsStorageProviderOptions,
): StorageProvider {
  throw new Error("@epok/storage-fs: createFsStorageProvider is not implemented yet");
}
