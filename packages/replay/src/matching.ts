import {
  EMPTY_BODY_SHA256,
  REDACTION_SENTINEL,
  type Dependency,
  type HeaderField,
} from "@epok/core";
import type { ReplayMismatch } from "./types.js";

export type DependencyMatchMode = "strict" | "snapshot" | "diagnostic-lenient";

/** Live outbound attempt after inject adapts fetch args. */
export interface OutboundMatchAttempt {
  method: string;
  url: string;
  headers?: readonly HeaderField[];
  bodyHash?: string;
}

export interface OutboundMatch {
  dependency: Dependency;
  softMismatch?: ReplayMismatch;
}

const SIGNATURE_EXCLUDED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function withUpperMethod(dependency: Dependency): Dependency {
  return {
    ...dependency,
    request: {
      ...dependency.request,
      method: dependency.request.method.toUpperCase(),
    },
  };
}

function attemptBodyHash(bodyHash: string | undefined): string {
  return bodyHash && bodyHash.length > 0 ? bodyHash : EMPTY_BODY_SHA256;
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

function urlsMatchIgnoringRedactedSecrets(
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

function matchesSelectedSignatureFields(
  dependency: Dependency,
  attempt: OutboundMatchAttempt,
): boolean {
  if (dependency.request.body.cas.hash !== attemptBodyHash(attempt.bodyHash)) {
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

function matchInPool(
  unused: readonly Dependency[],
  attempt: OutboundMatchAttempt,
  seq?: number,
): Dependency | undefined {
  const method = normalizeMethod(attempt.method);
  const candidates = unused.filter(
    (dep) =>
      normalizeMethod(dep.request.method) === method &&
      urlsMatchIgnoringRedactedSecrets(dep.request.url, attempt.url),
  );

  if (seq !== undefined) {
    return candidates.find((dep) => dep.seq === seq);
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

  return undefined;
}

function matchSnapshotInPool(
  unused: readonly Dependency[],
  attempt: OutboundMatchAttempt,
): Dependency | undefined {
  const method = normalizeMethod(attempt.method);
  const bucket = unused
    .filter((dep) => {
      if (normalizeMethod(dep.request.method) !== method) return false;
      if (!urlsMatchIgnoringRedactedSecrets(dep.request.url, attempt.url)) {
        return false;
      }
      return matchesSelectedSignatureFields(dep, attempt);
    })
    .sort((a, b) => a.seq - b.seq);
  return bucket[0];
}

function matchUnusedStrict(
  unused: ReadonlyMap<number, Dependency>,
  attempt: OutboundMatchAttempt,
): Dependency | undefined {
  const normalized = [...unused.values()].map(withUpperMethod);
  const matched = matchInPool(normalized, attempt);
  if (matched) return unused.get(matched.seq);

  const sameKey = normalized
    .filter(
      (dep) =>
        dep.request.method === normalizeMethod(attempt.method) &&
        urlsMatchIgnoringRedactedSecrets(dep.request.url, attempt.url),
    )
    .sort((a, b) => a.seq - b.seq);
  const next = sameKey[0];
  if (next === undefined) return undefined;

  const bySeq = matchInPool(normalized, attempt, next.seq);
  if (!bySeq) return undefined;
  return unused.get(bySeq.seq);
}

function matchUnusedSnapshot(
  unused: ReadonlyMap<number, Dependency>,
  attempt: OutboundMatchAttempt,
): Dependency | undefined {
  const pool = [...unused.values()].map(withUpperMethod);
  const matched = matchSnapshotInPool(pool, attempt);
  if (!matched) return undefined;
  return unused.get(matched.seq);
}

function matchUnusedLenient(
  unused: ReadonlyMap<number, Dependency>,
  attempt: OutboundMatchAttempt,
): OutboundMatch | undefined {
  const strict = matchUnusedStrict(unused, attempt);
  if (strict) return { dependency: strict };

  const sameMethod = [...unused.values()]
    .map(withUpperMethod)
    .filter((dep) => dep.request.method === normalizeMethod(attempt.method))
    .sort((a, b) => a.seq - b.seq);
  const next = sameMethod[0];
  if (next === undefined) return undefined;

  const dependency = unused.get(next.seq);
  if (!dependency) return undefined;

  return {
    dependency,
    softMismatch: {
      code: "dependency_mismatch",
      message: `relaxed match for ${attempt.method} ${attempt.url} → recorded ${dependency.request.url} (seq=${dependency.seq})`,
      method: attempt.method,
      url: attempt.url,
      dependencySeq: dependency.seq,
    },
  };
}

/**
 * Unused recorded dependencies for one replay. `match` consumes the chosen row.
 */
export class MatchPool {
  private readonly unused: Map<number, Dependency>;
  private readonly mode: DependencyMatchMode;

  constructor(dependencies: readonly Dependency[], mode: DependencyMatchMode) {
    this.unused = new Map(dependencies.map((dep) => [dep.seq, dep] as const));
    this.mode = mode;
  }

  match(attempt: OutboundMatchAttempt): OutboundMatch | undefined {
    const normalized: OutboundMatchAttempt = {
      ...attempt,
      method: normalizeMethod(attempt.method),
    };

    let result: OutboundMatch | undefined;
    if (this.mode === "snapshot") {
      const dependency = matchUnusedSnapshot(this.unused, normalized);
      result = dependency ? { dependency } : undefined;
    } else if (this.mode === "diagnostic-lenient") {
      result = matchUnusedLenient(this.unused, normalized);
    } else {
      const dependency = matchUnusedStrict(this.unused, normalized);
      result = dependency ? { dependency } : undefined;
    }

    if (result) {
      this.unused.delete(result.dependency.seq);
    }
    return result;
  }
}
