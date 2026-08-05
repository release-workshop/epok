import { describe, expect, it } from "vitest";
import {
  EMBEDDED_OBJECT_MAX_BYTES,
  StorageError,
  casKeyFromRef,
  mayEmbedObject,
} from "../src/index.js";

describe("CAS helpers", () => {
  it("allows embedding bodies strictly under 16 KiB", () => {
    expect(mayEmbedObject(0)).toBe(true);
    expect(mayEmbedObject(EMBEDDED_OBJECT_MAX_BYTES - 1)).toBe(true);
    expect(mayEmbedObject(EMBEDDED_OBJECT_MAX_BYTES)).toBe(false);
  });

  it("derives a CAS key from a body reference", () => {
    expect(
      casKeyFromRef({
        alg: "sha256",
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        size: 0,
        contentType: null,
        contentEncoding: null,
      }),
    ).toEqual({
      alg: "sha256",
      hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });
});

describe("StorageError", () => {
  it("carries a typed failure code", () => {
    const error = new StorageError("not_found", "manifest missing");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("manifest missing");
  });
});
