import { describe, expect, it } from "vitest";
import {
  EMPTY_BODY_SHA256,
  REDACTION_SENTINEL,
  type Dependency,
  type HeaderField,
} from "@epok/core";
import { MatchPool } from "../src/matching.js";

const emptyBody = {
  cas: {
    alg: "sha256" as const,
    hash: EMPTY_BODY_SHA256,
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

describe("MatchPool strict", () => {
  it("matches by method and URL and consumes the row", () => {
    const pool = new MatchPool(
      [
        dep({ seq: 1, method: "GET", url: "https://api.test/a" }),
        dep({ seq: 2, method: "POST", url: "https://api.test/b" }),
      ],
      "strict",
    );

    expect(
      pool.match({ method: "POST", url: "https://api.test/b" })?.dependency.seq,
    ).toBe(2);
    expect(
      pool.match({ method: "POST", url: "https://api.test/b" }),
    ).toBeUndefined();
  });

  it("consumes identical method+URL retries in unused seq order", () => {
    const pool = new MatchPool(
      [
        dep({ seq: 1, method: "GET", url: "https://api.test/retry" }),
        dep({ seq: 2, method: "GET", url: "https://api.test/retry" }),
      ],
      "strict",
    );

    expect(
      pool.match({ method: "GET", url: "https://api.test/retry" })?.dependency
        .seq,
    ).toBe(1);
    expect(
      pool.match({ method: "GET", url: "https://api.test/retry" })?.dependency
        .seq,
    ).toBe(2);
    expect(
      pool.match({ method: "GET", url: "https://api.test/retry" }),
    ).toBeUndefined();
  });

  it("returns undefined when no candidate matches", () => {
    const pool = new MatchPool(
      [dep({ seq: 1, method: "GET", url: "https://api.test/a" })],
      "strict",
    );

    expect(
      pool.match({ method: "DELETE", url: "https://api.test/a" }),
    ).toBeUndefined();
  });

  it("disambiguates identical method+URL by selected headers and body hash", () => {
    const pool = new MatchPool(
      [
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
      ],
      "strict",
    );

    expect(
      pool.match({
        method: "POST",
        url: "https://api.test/pay",
        headers: [{ name: "content-type", value: "text/plain" }],
        bodyHash: "body-b",
      })?.dependency.seq,
    ).toBe(2);
  });

  it("keeps method+URL unique matches without requiring headers or body", () => {
    const pool = new MatchPool(
      [
        dep({
          seq: 1,
          method: "POST",
          url: "https://api.test/pay",
          headers: [{ name: "Content-Type", value: "application/json" }],
          bodyHash: "body-a",
        }),
      ],
      "strict",
    );

    expect(
      pool.match({ method: "POST", url: "https://api.test/pay" })?.dependency
        .seq,
    ).toBe(1);
  });

  it("does not use redacted or auth header values as match material", () => {
    const pool = new MatchPool(
      [
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
      ],
      "strict",
    );

    expect(
      pool.match({
        method: "GET",
        url: "https://api.test/a",
        headers: [
          { name: "authorization", value: "Bearer live-secret" },
          { name: "x-custom", value: "live-token" },
          { name: "accept", value: "text/plain" },
        ],
      })?.dependency.seq,
    ).toBe(2);
  });

  it("matches URLs while ignoring redacted query parameter values", () => {
    const pool = new MatchPool(
      [
        dep({
          seq: 1,
          method: "GET",
          url: `https://api.test/a?api_key=${REDACTION_SENTINEL}&id=7`,
        }),
      ],
      "strict",
    );

    expect(
      pool.match({
        method: "GET",
        url: "https://api.test/a?api_key=super-secret&id=7",
      })?.dependency.seq,
    ).toBe(1);
  });
});

describe("MatchPool snapshot", () => {
  it("matches by method, URL, selected headers, and body hash", () => {
    const pool = new MatchPool(
      [
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
      ],
      "snapshot",
    );

    expect(
      pool.match({
        method: "POST",
        url: "https://api.test/pay",
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "authorization", value: "Bearer anything" },
        ],
        bodyHash: "abc123",
      })?.dependency.seq,
    ).toBe(1);
  });

  it("falls back to recorded seq order within the same signature bucket", () => {
    const pool = new MatchPool(
      [
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
      ],
      "snapshot",
    );

    expect(
      pool.match({
        method: "GET",
        url: "https://api.test/retry",
        headers: [{ name: "accept", value: "application/json" }],
      })?.dependency.seq,
    ).toBe(1);
  });

  it("ignores extra live headers not present on the recorded request", () => {
    const pool = new MatchPool(
      [
        dep({
          seq: 1,
          method: "GET",
          url: "https://api.test/a",
          headers: [{ name: "Accept", value: "application/json" }],
        }),
      ],
      "snapshot",
    );

    expect(
      pool.match({
        method: "GET",
        url: "https://api.test/a",
        headers: [
          { name: "accept", value: "application/json" },
          { name: "accept-encoding", value: "gzip" },
          { name: "user-agent", value: "test" },
        ],
      })?.dependency.seq,
    ).toBe(1);
  });
});

describe("MatchPool diagnostic-lenient", () => {
  it("soft-matches the lowest unused same-method row and reports a mismatch", () => {
    const pool = new MatchPool(
      [dep({ seq: 3, method: "GET", url: "https://api.test/recorded" })],
      "diagnostic-lenient",
    );

    const matched = pool.match({
      method: "GET",
      url: "https://api.test/live-other",
    });
    expect(matched?.dependency.seq).toBe(3);
    expect(matched?.softMismatch?.code).toBe("dependency_mismatch");
    expect(matched?.softMismatch?.dependencySeq).toBe(3);
  });

  it("prefers a strict match over a relaxed same-method row", () => {
    const pool = new MatchPool(
      [
        dep({ seq: 1, method: "GET", url: "https://api.test/other" }),
        dep({ seq: 2, method: "GET", url: "https://api.test/exact" }),
      ],
      "diagnostic-lenient",
    );

    const matched = pool.match({
      method: "GET",
      url: "https://api.test/exact",
    });
    expect(matched?.dependency.seq).toBe(2);
    expect(matched?.softMismatch).toBeUndefined();
  });
});
