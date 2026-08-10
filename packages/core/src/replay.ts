import type { Dependency, HeaderField } from "./interaction.js";
import { REDACTION_SENTINEL } from "./sanitize.js";

/**
 * Strict executable re-run match key: method + URL, with optional richer
 * signature fields used only to disambiguate identical method+URL rows.
 * Matching must not rely on redacted secret header/query values.
 */
export interface ReplayMatchKey {
  method: string;
  url: string;
  headers?: readonly HeaderField[];
  /** CAS hash of attempt body bytes when present; omit/empty for no body. */
  bodyHash?: string;
}

export interface ReplayMatchOptions {
  /** Disambiguate retries / identical method+URL rows by recorded seq. */
  seq?: number;
}

/**
 * Snapshot/mock signature key inputs (RFC §5.2).
 * Auth cookie headers and redacted values are excluded from the signature.
 */
export interface SnapshotMatchAttempt {
  method: string;
  url: string;
  headers?: readonly HeaderField[];
  /** CAS hash of attempt body bytes when present; omit/empty for no body. */
  bodyHash?: string;
}

/** Headers never part of the snapshot/signature key (secrets / session). */
const SIGNATURE_EXCLUDED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

export function matchKeyFromDependency(dependency: Dependency): ReplayMatchKey {
  return {
    method: dependency.request.method,
    url: dependency.request.url,
  };
}

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

const EMPTY_BODY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function bodyHashFromDependency(dependency: Dependency): string {
  return dependency.request.body.cas.hash;
}

function attemptBodyHash(bodyHash: string | undefined): string {
  return bodyHash && bodyHash.length > 0 ? bodyHash : EMPTY_BODY_HASH;
}

function isSignatureExcludedHeader(name: string, value: string): boolean {
  return (
    SIGNATURE_EXCLUDED_HEADERS.has(name.toLowerCase()) ||
    value === REDACTION_SENTINEL
  );
}

function queryKeysWithRedactedValues(params: URLSearchParams): Set<string> {
  const redactedKeys = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (value === REDACTION_SENTINEL) redactedKeys.add(key);
  }
  return redactedKeys;
}

/**
 * Compare recorded vs live URLs without treating redacted query values as
 * match material. Non-redacted query entries, origin, and path must agree.
 */
export function urlsMatchIgnoringRedactedSecrets(
  recordedUrl: string,
  attemptUrl: string,
): boolean {
  if (recordedUrl === attemptUrl) return true;
  if (!recordedUrl.includes(REDACTION_SENTINEL)) return false;

  let recorded: URL;
  let attempt: URL;
  try {
    recorded = new URL(recordedUrl);
    attempt = new URL(attemptUrl);
  } catch {
    return false;
  }

  if (
    recorded.origin !== attempt.origin ||
    recorded.pathname !== attempt.pathname
  ) {
    return false;
  }

  const redactedKeys = queryKeysWithRedactedValues(recorded.searchParams);
  const recordedSignificant = significantQueryEntries(
    recorded.searchParams,
    redactedKeys,
  );
  const attemptSignificant = significantQueryEntries(
    attempt.searchParams,
    redactedKeys,
  );
  if (recordedSignificant.size !== attemptSignificant.size) return false;
  for (const [key, value] of recordedSignificant) {
    if (attemptSignificant.get(key) !== value) return false;
  }
  return true;
}

function significantQueryEntries(
  params: URLSearchParams,
  ignoreKeys: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of params.entries()) {
    if (ignoreKeys.has(key)) continue;
    if (value === REDACTION_SENTINEL) continue;
    out.set(key, value);
  }
  return out;
}

/**
 * True when attempt matches the dependency's selected non-secret headers and
 * body hash. Extra headers on the attempt are ignored.
 */
function matchesSelectedSignatureFields(
  dependency: Dependency,
  attempt: {
    headers?: readonly HeaderField[];
    bodyHash?: string;
  },
): boolean {
  if (
    bodyHashFromDependency(dependency) !== attemptBodyHash(attempt.bodyHash)
  ) {
    return false;
  }

  const byName = new Map<string, string>();
  for (const field of attempt.headers ?? []) {
    byName.set(field.name.toLowerCase(), field.value);
  }

  for (const field of dependency.request.headers) {
    if (isSignatureExcludedHeader(field.name, field.value)) continue;
    if (byName.get(field.name.toLowerCase()) !== field.value) return false;
  }
  return true;
}

function matchesSnapshotSignature(
  dependency: Dependency,
  attempt: SnapshotMatchAttempt,
): boolean {
  if (
    normalizeMethod(dependency.request.method) !==
    normalizeMethod(attempt.method)
  ) {
    return false;
  }
  if (!urlsMatchIgnoringRedactedSecrets(dependency.request.url, attempt.url)) {
    return false;
  }
  return matchesSelectedSignatureFields(dependency, attempt);
}

/**
 * Find a recorded dependency for an outbound attempt under executable matching.
 *
 * MVP-compatible: unique method+URL matches without requiring headers/body.
 * When multiple rows share method+URL, richer signature fields (selected
 * non-secret headers + body hash) disambiguate; `seq` still selects retries.
 */
export function matchDependency(
  recorded: readonly Dependency[],
  attempt: ReplayMatchKey,
  options?: ReplayMatchOptions,
): Dependency | undefined {
  const method = normalizeMethod(attempt.method);
  const candidates = recorded.filter(
    (dep) =>
      normalizeMethod(dep.request.method) === method &&
      urlsMatchIgnoringRedactedSecrets(dep.request.url, attempt.url),
  );

  if (options?.seq !== undefined) {
    return candidates.find((dep) => dep.seq === options.seq);
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const hasRicher =
    (attempt.headers !== undefined && attempt.headers.length > 0) ||
    (attempt.bodyHash !== undefined && attempt.bodyHash.length > 0);

  if (hasRicher) {
    const bucket = candidates
      .filter((dep) => matchesSelectedSignatureFields(dep, attempt))
      .sort((a, b) => a.seq - b.seq);
    if (bucket.length > 0) return bucket[0];
  }

  // Strict matching: identical method+URL retries require seq (caller) or
  // richer fields that selected a bucket above.
  return undefined;
}

/**
 * Snapshot/mock hybrid matcher: signature-oriented key (method, URL, selected
 * recorded headers, optional body hash), then lowest `seq` within the bucket
 * (RFC §5.2). Extra headers on the attempt are ignored. Redacted secrets are
 * never match material.
 */
export function matchSnapshotDependency(
  recorded: readonly Dependency[],
  attempt: SnapshotMatchAttempt,
): Dependency | undefined {
  const bucket = recorded
    .filter((dep) => matchesSnapshotSignature(dep, attempt))
    .sort((a, b) => a.seq - b.seq);
  return bucket[0];
}
