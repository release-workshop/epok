import { describe, expect, it } from "vitest";
import type { Dependency, HeaderField } from "../src/index.js";
import { matchDependency, matchSnapshotDependency } from "../src/index.js";

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
  headers?: HeaderField[];
  bodyHash?: string;
}): Dependency {
  const body =
    partial.bodyHash === undefined
      ? emptyBody
      : {
          cas: {
            alg: "sha256" as const,
            hash: partial.bodyHash,
            size: 4,
            contentType: "application/json",
            contentEncoding: null,
          },
        };
  return {
    seq: partial.seq,
    startedAt: 0,
    endedAt: 1,
    request: {
      protocol: "HTTP/1.1",
      method: partial.method,
      url: partial.url,
      headers: partial.headers ?? [],
      body,
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

describe("snapshot dependency matching", () => {
  it("matches by method, URL, selected headers, and body hash", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "POST",
        url: "https://api.test/pay",
        headers: [
          { name: "Content-Type", value: "application/json" },
          { name: "Authorization", value: "[REDACTED]" },
        ],
        bodyHash: "abc123",
      }),
      dep({
        seq: 2,
        method: "POST",
        url: "https://api.test/pay",
        headers: [{ name: "Content-Type", value: "text/plain" }],
        bodyHash: "abc123",
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "POST",
      url: "https://api.test/pay",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "authorization", value: "Bearer anything" },
      ],
      bodyHash: "abc123",
    });

    expect(matched?.seq).toBe(1);
  });

  it("falls back to recorded seq order within the same signature bucket", () => {
    const recorded = [
      dep({
        seq: 2,
        method: "GET",
        url: "https://api.test/retry",
        headers: [{ name: "Accept", value: "application/json" }],
      }),
      dep({
        seq: 1,
        method: "GET",
        url: "https://api.test/retry",
        headers: [{ name: "Accept", value: "application/json" }],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/retry",
      headers: [{ name: "accept", value: "application/json" }],
    });

    expect(matched?.seq).toBe(1);
  });

  it("ignores auth headers when building the signature key", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: "https://api.test/a",
        headers: [{ name: "Authorization", value: "[REDACTED]" }],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/a",
      headers: [{ name: "authorization", value: "Bearer other" }],
    });

    expect(matched?.seq).toBe(1);
  });

  it("ignores extra live headers not present on the recorded request", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: "https://api.test/a",
        headers: [{ name: "Accept", value: "application/json" }],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/a",
      headers: [
        { name: "accept", value: "application/json" },
        { name: "accept-encoding", value: "gzip" },
        { name: "user-agent", value: "test" },
      ],
    });

    expect(matched?.seq).toBe(1);
  });
});
