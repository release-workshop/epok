import type {
  HeaderField,
  RulesetIdentity,
  SanitizerIdentity,
} from "./interaction.js";

/** Visible replacement for redacted secret values. */
export const REDACTION_SENTINEL = "[Epok:redacted]";

export const SANITIZER_VERSION = "1.0.0";

export const MINIMAL_RULESET_ID = "epok.minimal";

/**
 * SHA-256 (hex) of the frozen minimal ruleset definition JSON:
 * `{ id, headers, keys, sentinel }` with the arrays/constants below.
 * Precomputed so `@epok/core` stays free of Node-only crypto APIs.
 */
export const MINIMAL_RULESET_HASH =
  "373d8477677c1f37e0ca32c3bd36a18536fb980fc13f3feafc1adafa449c3125";

/** Header names redacted by the Epok-owned minimal ruleset (case-insensitive). */
export const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
] as const;

/**
 * Query / JSON / form keys redacted by the minimal ruleset (case-insensitive).
 * Matching ignores `-` / `_` so `api_key`, `api-key`, and `apikey` align.
 */
export const SENSITIVE_KEY_NAMES = [
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "key",
] as const;

export interface SanitizeMessageInput {
  headers: HeaderField[];
  /** Full request URL; query values for denied keys are redacted. */
  url?: string;
  body?: Uint8Array;
  contentType?: string | null;
}

export interface SanitizeMessageResult {
  headers: HeaderField[];
  url?: string;
  body?: Uint8Array;
}

/** Extension point: additional sanitizer pass over a message. */
export interface SanitizerRule {
  sanitize(input: SanitizeMessageResult): SanitizeMessageResult;
}

export interface Sanitizer {
  identity: SanitizerIdentity;
  ruleset: RulesetIdentity;
  sanitize(input: SanitizeMessageInput): SanitizeMessageResult;
}

export interface CreateSanitizerOptions {
  /** Extra rules applied after the built-in minimal ruleset. */
  extraRules?: readonly SanitizerRule[];
}

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

const SENSITIVE_HEADER_SET = new Set(
  SENSITIVE_HEADER_NAMES.map((n) => n.toLowerCase()),
);

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEY_NAMES.map(normalizeKey));

function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(name));
}

function redactHeaders(headers: HeaderField[]): HeaderField[] {
  return headers.map((header) =>
    SENSITIVE_HEADER_SET.has(header.name.toLowerCase())
      ? { name: header.name, value: REDACTION_SENTINEL }
      : { name: header.name, value: header.value },
  );
}

function redactSearchParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of params) {
    next.append(key, isSensitiveKey(key) ? REDACTION_SENTINEL : value);
  }
  return next;
}

function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("sanitizer cannot redact unparseable URL");
  }

  const query = redactSearchParams(
    new URLSearchParams(parsed.search),
  ).toString();
  parsed.search = query.length > 0 ? `?${query}` : "";
  return parsed.toString();
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = isSensitiveKey(key)
        ? REDACTION_SENTINEL
        : redactJsonValue(child);
    }
    return out;
  }
  return value;
}

function mediaType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const [type] = contentType.split(";", 1);
  return (type ?? contentType).trim().toLowerCase();
}

function redactBody(
  body: Uint8Array,
  contentType: string | null | undefined,
): Uint8Array {
  const type = mediaType(contentType);
  if (type === "application/json" || (type?.endsWith("+json") ?? false)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error(
        "sanitizer cannot redact unparseable application/json body",
      );
    }
    return new TextEncoder().encode(JSON.stringify(redactJsonValue(parsed)));
  }
  if (type === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(new TextDecoder().decode(body));
    return new TextEncoder().encode(redactSearchParams(params).toString());
  }
  return body;
}

function applyMinimalRules(input: SanitizeMessageInput): SanitizeMessageResult {
  const result: SanitizeMessageResult = {
    headers: redactHeaders(input.headers),
  };
  if (input.url !== undefined) {
    result.url = redactUrl(input.url);
  }
  if (input.body !== undefined) {
    result.body = redactBody(input.body, input.contentType);
  }
  return result;
}

export function minimalRulesetIdentity(): RulesetIdentity {
  return { id: MINIMAL_RULESET_ID, hash: MINIMAL_RULESET_HASH };
}

/**
 * Build the Epok-owned minimal sanitizer, optionally composing extension rules.
 */
export function createSanitizer(
  options: CreateSanitizerOptions = {},
): Sanitizer {
  const extraRules = options.extraRules ?? [];
  const ruleset = minimalRulesetIdentity();

  return {
    identity: { version: SANITIZER_VERSION },
    ruleset,
    sanitize(input: SanitizeMessageInput): SanitizeMessageResult {
      let current = applyMinimalRules(input);
      for (const rule of extraRules) {
        current = rule.sanitize(current);
      }
      return current;
    },
  };
}
