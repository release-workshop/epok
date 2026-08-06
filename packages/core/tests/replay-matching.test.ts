import { describe, expect, it } from "vitest";
import type { Dependency } from "../src/index.js";
import { matchDependency } from "../src/index.js";

const emptyBody = {
  cas: {
    alg: "sha256" as const,
    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    size: 0,
    contentType: null,
    contentEncoding: null,
  },
};

function dep(partial: {
  seq: number;
  method: string;
  url: string;
}): Dependency {
  return {
    seq: partial.seq,
    startedAt: 0,
    endedAt: 1,
    request: {
      protocol: "HTTP/1.1",
      method: partial.method,
      url: partial.url,
      headers: [],
      body: emptyBody,
    },
    response: {
      protocol: "HTTP/1.1",
      status: 200,
      headers: [],
      body: emptyBody,
    },
  };
}

describe("replay request matching", () => {
  it("matches by method and URL", () => {
    const recorded = [
      dep({ seq: 1, method: "GET", url: "https://api.test/a" }),
      dep({ seq: 2, method: "POST", url: "https://api.test/b" }),
    ];

    const matched = matchDependency(recorded, {
      method: "POST",
      url: "https://api.test/b",
    });

    expect(matched?.seq).toBe(2);
  });

  it("disambiguates identical method+URL pairs by seq", () => {
    const recorded = [
      dep({ seq: 1, method: "GET", url: "https://api.test/retry" }),
      dep({ seq: 2, method: "GET", url: "https://api.test/retry" }),
    ];

    const matched = matchDependency(
      recorded,
      { method: "GET", url: "https://api.test/retry" },
      { seq: 2 },
    );

    expect(matched?.seq).toBe(2);
  });

  it("refuses ambiguous method+URL matches without seq", () => {
    const recorded = [
      dep({ seq: 1, method: "GET", url: "https://api.test/retry" }),
      dep({ seq: 2, method: "GET", url: "https://api.test/retry" }),
    ];

    expect(
      matchDependency(recorded, {
        method: "GET",
        url: "https://api.test/retry",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no candidate matches", () => {
    const recorded = [
      dep({ seq: 1, method: "GET", url: "https://api.test/a" }),
    ];

    expect(
      matchDependency(recorded, {
        method: "DELETE",
        url: "https://api.test/a",
      }),
    ).toBeUndefined();
  });
});
