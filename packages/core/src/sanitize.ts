import type {
  HeaderField,
  RulesetIdentity,
  SanitizerIdentity,
} from "./interaction.js";

/** Visible replacement for redacted secret values. */
export const REDACTION_SENTINEL = "[Epok:redacted]";

const SANITIZER_VERSION = "1.0.0";

const MINIMAL_RULESET_ID = "epok.minimal";

/**
 * SHA-256 (hex) of the frozen minimal ruleset definition JSON:
 * `{ id, headers, keys, sentinel }` with the private lists below.
 * Precomputed so `@epok/core` stays free of Node-only crypto APIs.
 */
const MINIMAL_RULESET_HASH =
  "373d8477677c1f37e0ca32c3bd36a18536fb980fc13f3feafc1adafa449c3125";

/** Header names redacted by the Epok-owned minimal ruleset (case-insensitive). */
const SENSITIVE_HEADER_NAMES = [
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
const SENSITIVE_KEY_NAMES = [
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

/** Built-in selectable packs applied after the minimal ruleset. */
export type SanitizerPackId = "patterns";

export interface CreateSanitizerOptions {
  /** Built-in packs applied after the minimal ruleset, before `extraRules`. */
  packs?: readonly SanitizerPackId[];
  /** Extra rules applied after the built-in minimal ruleset (and packs). */
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

/** Email-shaped substrings (Epok-owned; not a peer product ruleset). */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** `Bearer <token>` credentials embedded in free text. */
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Compact JWT-shaped triples (header.payload.signature). */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** 16-digit PAN-shaped groups with optional spaces/dashes. */
const PAN_PATTERN = /\b\d{4}(?:[ -]?\d{4}){3}\b/g;

function redactPatternsInText(text: string): string {
  return text
    .replace(BEARER_PATTERN, REDACTION_SENTINEL)
    .replace(JWT_PATTERN, REDACTION_SENTINEL)
    .replace(EMAIL_PATTERN, REDACTION_SENTINEL)
    .replace(PAN_PATTERN, REDACTION_SENTINEL);
}

function redactPatternsInJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPatternsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactPatternsInJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = redactPatternsInJsonValue(child);
    }
    return out;
  }
  return value;
}

function redactPatternsInBody(
  body: Uint8Array,
  contentType: string | null | undefined,
): Uint8Array {
  const type = mediaType(contentType);
  const text = new TextDecoder().decode(body);
  if (type === "application/json" || (type?.endsWith("+json") ?? false)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        "sanitizer cannot redact unparseable application/json body",
      );
    }
    return new TextEncoder().encode(
      JSON.stringify(redactPatternsInJsonValue(parsed)),
    );
  }
  if (type === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(text);
    const next = new URLSearchParams();
    for (const [key, value] of params) {
      next.append(key, redactPatternsInText(value));
    }
    return new TextEncoder().encode(next.toString());
  }
  if (type?.startsWith("text/")) {
    return new TextEncoder().encode(redactPatternsInText(text));
  }
  return body;
}

function applyPatternsPack(
  input: SanitizeMessageResult,
  contentType: string | null | undefined,
): SanitizeMessageResult {
  if (input.body === undefined) return input;
  const type =
    contentType ??
    input.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ??
    null;
  return {
    ...input,
    body: redactPatternsInBody(input.body, type),
  };
}

/**
 * SHA-256 (hex) of the frozen composed ruleset definition JSON when packs
 * include `patterns`: `{ id, base, packs, sentinel }` with base = minimal
 * definition and packs =
 * `[{ id: "patterns", patterns: ["email","bearer","jwt","pan"] }]`.
 */
const MINIMAL_PLUS_PATTERNS_RULESET_ID = "epok.minimal+patterns";
const MINIMAL_PLUS_PATTERNS_RULESET_HASH =
  "051ee834621c2501046ecd47306f87c830ad00f68662d479452b2c884893e62a";

function resolveRuleset(packs: readonly SanitizerPackId[]): RulesetIdentity {
  if (packs.length === 0) {
    return { id: MINIMAL_RULESET_ID, hash: MINIMAL_RULESET_HASH };
  }
  const unique = [...new Set(packs)];
  if (unique.length === 1 && unique[0] === "patterns") {
    return {
      id: MINIMAL_PLUS_PATTERNS_RULESET_ID,
      hash: MINIMAL_PLUS_PATTERNS_RULESET_HASH,
    };
  }
  throw new Error(`unsupported sanitizer packs: ${unique.join(",")}`);
}

/**
 * Build the Epok-owned minimal sanitizer, optionally composing packs and
 * extension rules. Ruleset identity is on the returned `sanitizer.ruleset`.
 */
export function createSanitizer(
  options: CreateSanitizerOptions = {},
): Sanitizer {
  const packs = options.packs ?? [];
  const applyPatterns = packs.includes("patterns");
  const extraRules = options.extraRules ?? [];

  return {
    identity: { version: SANITIZER_VERSION },
    ruleset: resolveRuleset(packs),
    sanitize(input: SanitizeMessageInput): SanitizeMessageResult {
      let current = applyMinimalRules(input);
      if (applyPatterns) {
        current = applyPatternsPack(current, input.contentType);
      }
      for (const rule of extraRules) {
        current = rule.sanitize(current);
      }
      return current;
    },
  };
}
