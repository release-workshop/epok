import { describe, expect, it } from "vitest";
import type { AttachRecorderOptions } from "../../recorder/src/index.js";
import type { StorageProvider } from "../src/index.js";
import { StorageError } from "../src/index.js";

describe("recorder consumes core without Node types in core", () => {
  it("types AttachRecorderOptions against the Storage Provider seam", () => {
    const storage: StorageProvider = {
      durability: "best-effort",
      async putManifest() {},
      async getManifest() {
        throw new StorageError("not_found", "missing");
      },
      async putObject() {
        return { created: true };
      },
      async getObject() {
        throw new StorageError("not_found", "missing");
      },
      async hasObject() {
        return false;
      },
    };

    const options: AttachRecorderOptions = { storage };
    expect(options.storage.durability).toBe("best-effort");
  });
});
