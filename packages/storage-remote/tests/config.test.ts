import { describe, expect, it } from "vitest";
import { createRemoteStorageProvider } from "../src/index.js";

describe("createRemoteStorageProvider config", () => {
  it("requires an explicit non-empty endpoint", () => {
    expect(() =>
      createRemoteStorageProvider({
        endpoint: "",
      }),
    ).toThrow(/endpoint/i);

    expect(() =>
      createRemoteStorageProvider({
        endpoint: "   ",
      }),
    ).toThrow(/endpoint/i);
  });
});
