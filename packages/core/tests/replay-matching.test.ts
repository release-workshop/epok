import { describe, expect, it } from "vitest";
import type { Dependency, HeaderField } from "../src/index.js";
import {
  REDACTION_SENTINEL,
  matchDependency,
  matchSnapshotDependency,
} from "../src/index.js";

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

  it("disambiguates identical method+URL by selected headers and body hash", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "POST",
        url: "https://api.test/pay",
        headers: [{ name: "Content-Type", value: "application/json" }],
        bodyHash: "body-a",
      }),
      dep({
        seq: 2,
        method: "POST",
        url: "https://api.test/pay",
        headers: [{ name: "Content-Type", value: "text/plain" }],
        bodyHash: "body-b",
      }),
    ];

    const matched = matchDependency(recorded, {
      method: "POST",
      url: "https://api.test/pay",
      headers: [{ name: "content-type", value: "text/plain" }],
      bodyHash: "body-b",
    });

    expect(matched?.seq).toBe(2);
  });

  it("keeps method+URL unique matches without requiring headers or body", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "POST",
        url: "https://api.test/pay",
        headers: [{ name: "Content-Type", value: "application/json" }],
        bodyHash: "body-a",
      }),
    ];

    const matched = matchDependency(recorded, {
      method: "POST",
      url: "https://api.test/pay",
    });

    expect(matched?.seq).toBe(1);
  });

  it("does not use redacted or auth header values as match material", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: "https://api.test/a",
        headers: [
          { name: "Authorization", value: REDACTION_SENTINEL },
          { name: "X-Custom", value: REDACTION_SENTINEL },
          { name: "Accept", value: "application/json" },
        ],
      }),
      dep({
        seq: 2,
        method: "GET",
        url: "https://api.test/a",
        headers: [
          { name: "Authorization", value: REDACTION_SENTINEL },
          { name: "X-Custom", value: REDACTION_SENTINEL },
          { name: "Accept", value: "text/plain" },
        ],
      }),
    ];

    const matched = matchDependency(recorded, {
      method: "GET",
      url: "https://api.test/a",
      headers: [
        { name: "authorization", value: "Bearer live-secret" },
        { name: "x-custom", value: "live-token" },
        { name: "accept", value: "text/plain" },
      ],
    });

    expect(matched?.seq).toBe(2);
  });

  it("matches URLs while ignoring redacted query parameter values", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: `https://api.test/a?api_key=${REDACTION_SENTINEL}&id=7`,
      }),
    ];

    const matched = matchDependency(recorded, {
      method: "GET",
      url: "https://api.test/a?api_key=super-secret&id=7",
    });

    expect(matched?.seq).toBe(1);
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
          { name: "Authorization", value: REDACTION_SENTINEL },
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
        headers: [{ name: "Authorization", value: REDACTION_SENTINEL }],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/a",
      headers: [{ name: "authorization", value: "Bearer other" }],
    });

    expect(matched?.seq).toBe(1);
  });

  it("ignores redacted non-auth header values in the signature key", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: "https://api.test/a",
        headers: [
          { name: "X-Api-Token", value: REDACTION_SENTINEL },
          { name: "Accept", value: "application/json" },
        ],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/a",
      headers: [
        { name: "x-api-token", value: "live-secret" },
        { name: "accept", value: "application/json" },
      ],
    });

    expect(matched?.seq).toBe(1);
  });

  it("matches snapshot URLs while ignoring redacted query values", () => {
    const recorded = [
      dep({
        seq: 1,
        method: "GET",
        url: `https://api.test/a?token=${REDACTION_SENTINEL}`,
        headers: [{ name: "Accept", value: "application/json" }],
      }),
    ];

    const matched = matchSnapshotDependency(recorded, {
      method: "GET",
      url: "https://api.test/a?token=live-secret",
      headers: [{ name: "accept", value: "application/json" }],
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
