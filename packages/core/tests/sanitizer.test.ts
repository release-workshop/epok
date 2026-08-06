import { describe, expect, it } from "vitest";
import { REDACTION_SENTINEL, createSanitizer } from "../src/index.js";

describe("minimal sanitizer ruleset", () => {
  const sanitizer = createSanitizer();

  it("redacts auth, cookie, and api-key class headers", () => {
    const result = sanitizer.sanitize({
      headers: [
        { name: "Authorization", value: "Bearer secret-token" },
        { name: "Cookie", value: "session=abc" },
        { name: "Set-Cookie", value: "session=abc; HttpOnly" },
        { name: "X-Api-Key", value: "key-123" },
        { name: "Api-Key", value: "key-456" },
        { name: "Proxy-Authorization", value: "Basic dXNlcjpwYXNz" },
        { name: "Content-Type", value: "application/json" },
        { name: "X-Request-Id", value: "req-1" },
      ],
    });

    expect(result.headers).toEqual([
      { name: "Authorization", value: REDACTION_SENTINEL },
      { name: "Cookie", value: REDACTION_SENTINEL },
      { name: "Set-Cookie", value: REDACTION_SENTINEL },
      { name: "X-Api-Key", value: REDACTION_SENTINEL },
      { name: "Api-Key", value: REDACTION_SENTINEL },
      { name: "Proxy-Authorization", value: REDACTION_SENTINEL },
      { name: "Content-Type", value: "application/json" },
      { name: "X-Request-Id", value: "req-1" },
    ]);
  });

  it("redacts denied query keys while preserving others", () => {
    const result = sanitizer.sanitize({
      headers: [],
      url: "https://api.example/v1?q=hello&api_key=sekrit&token=t1&page=2&access_token=at",
    });

    expect(result.url).toBeDefined();
    if (result.url === undefined) return;

    const parsed = new URL(result.url);
    expect(parsed.searchParams.get("q")).toBe("hello");
    expect(parsed.searchParams.get("page")).toBe("2");
    expect(parsed.searchParams.get("api_key")).toBe(REDACTION_SENTINEL);
    expect(parsed.searchParams.get("token")).toBe(REDACTION_SENTINEL);
    expect(parsed.searchParams.get("access_token")).toBe(REDACTION_SENTINEL);
  });

  it("scrubs sensitive keys in JSON bodies", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        user: "ada",
        password: "hunter2",
        nested: { api_key: "k" },
      }),
    );
    const result = sanitizer.sanitize({
      headers: [{ name: "Content-Type", value: "application/json" }],
      body,
      contentType: "application/json",
    });

    expect(result.body).toBeDefined();
    if (result.body === undefined) return;

    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
      user: "ada",
      password: REDACTION_SENTINEL,
      nested: { api_key: REDACTION_SENTINEL },
    });
  });

  it("scrubs sensitive keys in form-urlencoded bodies", () => {
    const body = new TextEncoder().encode(
      "user=ada&password=hunter2&token=t1&ok=1",
    );
    const result = sanitizer.sanitize({
      headers: [
        {
          name: "Content-Type",
          value: "application/x-www-form-urlencoded",
        },
      ],
      body,
      contentType: "application/x-www-form-urlencoded",
    });

    expect(result.body).toBeDefined();
    if (result.body === undefined) return;

    const params = new URLSearchParams(new TextDecoder().decode(result.body));
    expect(params.get("user")).toBe("ada");
    expect(params.get("ok")).toBe("1");
    expect(params.get("password")).toBe(REDACTION_SENTINEL);
    expect(params.get("token")).toBe(REDACTION_SENTINEL);
  });

  it("throws when a claimed JSON body cannot be parsed safely", () => {
    expect(() =>
      sanitizer.sanitize({
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: new TextEncoder().encode("{not-json"),
        contentType: "application/json",
      }),
    ).toThrow(/unparseable application\/json/);
  });

  it("applies extension rules after the minimal ruleset", () => {
    const extended = createSanitizer({
      extraRules: [
        {
          sanitize(input) {
            return {
              ...input,
              headers: [
                ...input.headers,
                { name: "X-Extra", value: "applied" },
              ],
            };
          },
        },
      ],
    });

    const result = extended.sanitize({
      headers: [{ name: "Authorization", value: "Bearer x" }],
    });

    expect(result.headers).toEqual([
      { name: "Authorization", value: REDACTION_SENTINEL },
      { name: "X-Extra", value: "applied" },
    ]);
  });
});
