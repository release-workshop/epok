import { describe, expect, it } from "vitest";
import { EMPTY_BODY_SHA256, sha256Hex } from "../src/sha256.js";

describe("sha256Hex", () => {
  it("hashes bytes via Web Crypto", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_BODY_SHA256);
    expect(await sha256Hex(new TextEncoder().encode("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
