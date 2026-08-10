import type { Dependency, HeaderField } from "./interaction.js";

/**
 * Strict executable re-run match key: method + URL.
 * Matching must not rely on redacted secret header/query values.
 */
export interface ReplayMatchKey {
  method: string;
  url: string;
}

export interface ReplayMatchOptions {
  /** Disambiguate retries / identical method+URL rows by recorded seq. */
  seq?: number;
}

/**
 * Snapshot/mock signature key inputs (RFC §5.2).
 * Auth cookie headers are excluded from the signature.
 */
export interface SnapshotMatchAttempt {
  method: string;
  url: string;
  headers?: readonly HeaderField[];
  /** CAS hash of attempt body bytes when present; omit/empty for no body. */
  bodyHash?: string;
}

/** Headers never part of the snapshot signature (secrets / session). */
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

/**
 * Find a recorded dependency for an outbound attempt under strict matching.
 * When multiple rows share method+URL, pass `seq` to select the retry row.
 */
export function matchDependency(
  recorded: readonly Dependency[],
  attempt: ReplayMatchKey,
  options?: ReplayMatchOptions,
): Dependency | undefined {
  const candidates = recorded.filter(
    (dep) =>
      dep.request.method === attempt.method && dep.request.url === attempt.url,
  );

  if (options?.seq !== undefined) {
    return candidates.find((dep) => dep.seq === options.seq);
  }

  // Strict matching: identical method+URL retries require seq disambiguation.
  if (candidates.length !== 1) {
    return undefined;
  }

  return candidates[0];
}

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function bodyHashFromDependency(dependency: Dependency): string {
  return dependency.request.body.cas.hash;
}

function attemptBodyHash(attempt: SnapshotMatchAttempt): string {
  const emptyHash =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return attempt.bodyHash && attempt.bodyHash.length > 0
    ? attempt.bodyHash
    : emptyHash;
}

/**
 * True when attempt matches the dependency's snapshot signature key.
 * Selected headers are those on the recorded request (minus auth/cookie);
 * extra headers on the attempt are ignored.
 */
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
  if (dependency.request.url !== attempt.url) return false;
  if (bodyHashFromDependency(dependency) !== attemptBodyHash(attempt)) {
    return false;
  }

  const byName = new Map<string, string>();
  for (const field of attempt.headers ?? []) {
    byName.set(field.name.toLowerCase(), field.value);
  }

  for (const field of dependency.request.headers) {
    const name = field.name.toLowerCase();
    if (SIGNATURE_EXCLUDED_HEADERS.has(name)) continue;
    if (byName.get(name) !== field.value) return false;
  }
  return true;
}

/**
 * Snapshot/mock hybrid matcher: signature-oriented key (method, URL, selected
 * recorded headers, optional body hash), then lowest `seq` within the bucket
 * (RFC §5.2). Extra headers on the attempt are ignored.
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
