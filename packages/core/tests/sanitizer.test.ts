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

describe("patterns pack", () => {
  const sanitizer = createSanitizer({ packs: ["patterns"] });

  it("redacts email-shaped values in JSON bodies", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        user: "ada",
        email: "ada@example.com",
        note: "contact ada@example.com please",
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
      email: REDACTION_SENTINEL,
      note: `contact ${REDACTION_SENTINEL} please`,
    });
  });

  it("redacts JWT, Bearer, and PAN-shaped values in JSON bodies", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepaddingbase64urlchars";
    const body = new TextEncoder().encode(
      JSON.stringify({
        note: `Bearer ${jwt}`,
        jwt,
        card: "4111-1111-1111-1111",
        ok: "keep",
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
      note: REDACTION_SENTINEL,
      jwt: REDACTION_SENTINEL,
      card: REDACTION_SENTINEL,
      ok: "keep",
    });
  });

  it("redacts pattern matches in form-urlencoded and opaque text bodies", () => {
    const form = sanitizer.sanitize({
      headers: [
        {
          name: "Content-Type",
          value: "application/x-www-form-urlencoded",
        },
      ],
      body: new TextEncoder().encode("msg=hello+ada%40example.com&ok=1"),
      contentType: "application/x-www-form-urlencoded",
    });
    expect(form.body).toBeDefined();
    if (form.body === undefined) return;
    const params = new URLSearchParams(new TextDecoder().decode(form.body));
    expect(params.get("msg")).toBe(`hello ${REDACTION_SENTINEL}`);
    expect(params.get("ok")).toBe("1");

    const text = sanitizer.sanitize({
      headers: [{ name: "Content-Type", value: "text/plain" }],
      body: new TextEncoder().encode(
        "token=Bearer abc.def.ghi and mail ada@example.com",
      ),
      contentType: "text/plain",
    });
    expect(text.body).toBeDefined();
    if (text.body === undefined) return;
    expect(new TextDecoder().decode(text.body)).toBe(
      `token=${REDACTION_SENTINEL} and mail ${REDACTION_SENTINEL}`,
    );
  });

  it("exposes composed ruleset identity without changing the default", () => {
    const defaults = createSanitizer();
    expect(defaults.ruleset).toEqual({
      id: "epok.minimal",
      hash: "373d8477677c1f37e0ca32c3bd36a18536fb980fc13f3feafc1adafa449c3125",
    });
    expect(sanitizer.ruleset).toEqual({
      id: "epok.minimal+patterns",
      hash: "051ee834621c2501046ecd47306f87c830ad00f68662d479452b2c884893e62a",
    });
  });

  it("applies extraRules after packs", () => {
    const extended = createSanitizer({
      packs: ["patterns"],
      extraRules: [
        {
          sanitize(input) {
            return {
              ...input,
              headers: [
                ...input.headers,
                { name: "X-Extra", value: "after-packs" },
              ],
            };
          },
        },
      ],
    });
    const result = extended.sanitize({
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: new TextEncoder().encode(
        JSON.stringify({ email: "ada@example.com" }),
      ),
      contentType: "application/json",
    });
    expect(result.headers).toContainEqual({
      name: "X-Extra",
      value: "after-packs",
    });
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({
      email: REDACTION_SENTINEL,
    });
  });
});
