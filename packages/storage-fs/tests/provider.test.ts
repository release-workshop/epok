import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeStorageProviderContract } from "../../core/tests/storage-provider-contract.js";
import { createFsStorageProvider } from "../src/index.js";

describeStorageProviderContract("filesystem", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "epok-storage-fs-"));
  return {
    provider: createFsStorageProvider({ rootDir }),
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
});
