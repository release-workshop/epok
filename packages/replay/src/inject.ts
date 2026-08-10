import {
  matchDependency,
  matchSnapshotDependency,
  urlsMatchIgnoringRedactedSecrets,
  type Dependency,
  type HeaderField,
  type InteractionManifest,
  type ReplayMatchKey,
  type StorageProvider,
} from "@epok/core";
import { createHash } from "node:crypto";
import { headersFromFields, resolveCasBytes } from "./load.js";
import type { ReplayMismatch, ReplayTimingMode } from "./types.js";

/** Timer-resolution floor before a late completion is recorded as a timing note. */
const TIMING_DRIFT_NOTE_MS = 1;

function recordedDurationMs(dependency: Dependency): number {
  return Math.max(0, dependency.endedAt - dependency.startedAt);
}

/**
 * Best-effort realtime pacing: never complete earlier than recorded duration
 * from the live fetch start, and never earlier than recorded `endedAt` relative
 * to replay start (RFC §6).
 */
async function paceDependencyCompletion(
  dependency: Dependency,
  replayStartedAt: number,
  fetchStartedAt: number,
  timingNotes: string[],
): Promise<void> {
  const duration = recordedDurationMs(dependency);
  const earliestByDuration = fetchStartedAt + duration;
  const earliestByRelative = replayStartedAt + Math.max(0, dependency.endedAt);
  const target = Math.max(earliestByDuration, earliestByRelative);
  const waitMs = target - performance.now();
  if (waitMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
  const drift = performance.now() - target;
  if (drift > TIMING_DRIFT_NOTE_MS) {
    timingNotes.push(
      `seq=${dependency.seq} completed ${Math.round(drift)}ms after target pacing`,
    );
  }
}

export { headersFromFields };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL) && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function headerFieldsFromHeaders(headers: Headers): HeaderField[] {
  const fields: HeaderField[] = [];
  headers.forEach((value, name) => {
    fields.push({ name, value });
  });
  return fields;
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

/**
 * Strict match among unused rows: method + URL (MVP), richer signature fields
 * when ambiguous, then lowest unused `seq` for identical retries.
 */
function matchUnusedDependencyStrict(
  unused: ReadonlyMap<number, Dependency>,
  attempt: ReplayMatchKey,
): Dependency | undefined {
  const normalized = [...unused.values()].map(withUpperMethod);
  const matched = matchDependency(normalized, attempt);
  if (matched) return unused.get(matched.seq);

  const sameKey = normalized
    .filter(
      (dep) =>
        dep.request.method === attempt.method &&
        urlsMatchIgnoringRedactedSecrets(dep.request.url, attempt.url),
    )
    .sort((a, b) => a.seq - b.seq);
  const next = sameKey[0];
  if (next === undefined) return undefined;

  const bySeq = matchDependency(normalized, attempt, { seq: next.seq });
  if (!bySeq) return undefined;
  return unused.get(bySeq.seq);
}

/**
 * Snapshot hybrid match among unused rows (signature → seq).
 */
function matchUnusedDependencySnapshot(
  unused: ReadonlyMap<number, Dependency>,
  attempt: {
    method: string;
    url: string;
    headers: HeaderField[];
    bodyHash?: string;
  },
): Dependency | undefined {
  const pool = [...unused.values()].map(withUpperMethod);
  const matched = matchSnapshotDependency(pool, attempt);
  if (!matched) return undefined;
  return unused.get(matched.seq);
}

/**
 * Lenient: strict method+URL first; else lowest-seq unused same-method row.
 * Soft miss returns the dependency plus an actionable diagnostic.
 */
function matchUnusedDependencyLenient(
  unused: ReadonlyMap<number, Dependency>,
  attempt: { method: string; url: string },
): { dependency: Dependency; softMismatch?: ReplayMismatch } | undefined {
  const strict = matchUnusedDependencyStrict(unused, attempt);
  if (strict) return { dependency: strict };

  const sameMethod = [...unused.values()]
    .map(withUpperMethod)
    .filter((dep) => dep.request.method === attempt.method)
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

async function responseFromDependency(
  storage: StorageProvider,
  manifest: InteractionManifest,
  dependency: Dependency,
): Promise<Response> {
  if (dependency.error) {
    throw new Error(
      `recorded dependency seq=${dependency.seq} failed: ${dependency.error.type}: ${dependency.error.message}`,
    );
  }
  if (!dependency.response) {
    throw new Error(
      `recorded dependency seq=${dependency.seq} has no response to inject`,
    );
  }

  const body = await resolveCasBytes(
    storage,
    manifest,
    dependency.response.body.cas,
  );
  const init: ResponseInit = {
    status: dependency.response.status,
    headers: headersFromFields(dependency.response.headers),
  };
  if (dependency.response.statusText !== undefined) {
    init.statusText = dependency.response.statusText;
  }
  return new Response(Uint8Array.from(body), init);
}

export interface FetchInjection {
  restore: () => void;
  /** Mismatches accumulated during injection (lenient may soft-match and continue). */
  takeMismatches: () => ReplayMismatch[];
  /** True after a terminal dependency miss (no safe candidate to inject). */
  hadHardMismatch: () => boolean;
  /** Realtime pacing drift notes (empty for instant). */
  takeTimingNotes: () => string[];
}

export type DependencyMatchMode = "strict" | "snapshot" | "diagnostic-lenient";

async function attemptFromFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  method: string;
  url: string;
  headers: HeaderField[];
  bodyHash?: string;
}> {
  const method = requestMethod(input, init);
  const url = requestUrl(input);
  const headers = new Headers(
    init?.headers ??
      (typeof input !== "string" && !(input instanceof URL)
        ? input.headers
        : undefined),
  );
  let bodyHash: string | undefined;
  const bodyInit =
    init?.body ??
    (typeof input !== "string" && !(input instanceof URL)
      ? input.body
      : undefined);
  if (bodyInit !== undefined && bodyInit !== null) {
    const request = new Request(url, {
      method,
      headers,
      body: bodyInit,
    });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 0) {
      bodyHash = createHash("sha256").update(bytes).digest("hex");
    }
  }
  const attempt: {
    method: string;
    url: string;
    headers: HeaderField[];
    bodyHash?: string;
  } = {
    method,
    url,
    headers: headerFieldsFromHeaders(headers),
  };
  if (bodyHash !== undefined) {
    attempt.bodyHash = bodyHash;
  }
  return attempt;
}

function dependencyMismatch(method: string, url: string): ReplayMismatch {
  return {
    code: "dependency_mismatch",
    message: `no recorded dependency for ${method} ${url}`,
    method,
    url,
  };
}

type ExecutableMatch = {
  dependency: Dependency | undefined;
  softMismatch?: ReplayMismatch;
};

function matchExecutableAttempt(
  matching: Exclude<DependencyMatchMode, "snapshot">,
  unused: ReadonlyMap<number, Dependency>,
  attempt: ReplayMatchKey,
): ExecutableMatch {
  if (matching === "diagnostic-lenient") {
    const lenient = matchUnusedDependencyLenient(unused, attempt);
    if (!lenient) return { dependency: undefined };
    const result: ExecutableMatch = { dependency: lenient.dependency };
    if (lenient.softMismatch !== undefined) {
      result.softMismatch = lenient.softMismatch;
    }
    return result;
  }
  return { dependency: matchUnusedDependencyStrict(unused, attempt) };
}

/**
 * Install a `fetch` interceptor that injects recorded dependency responses.
 * Instant timing: responses resolve as soon as matching succeeds.
 * Realtime timing: delay completion per recorded duration + relative endedAt.
 * Never forwards to the prior `fetch` (no external network).
 */
export function installDependencyInjection(options: {
  storage: StorageProvider;
  manifest: InteractionManifest;
  matching?: DependencyMatchMode;
  timing?: ReplayTimingMode;
}): FetchInjection {
  const { storage, manifest } = options;
  const matching: DependencyMatchMode = options.matching ?? "strict";
  const timing: ReplayTimingMode = options.timing ?? "instant";
  const unused = new Map(
    manifest.dependencies.map((dep) => [dep.seq, dep] as const),
  );
  const mismatches: ReplayMismatch[] = [];
  const timingNotes: string[] = [];
  let hardMismatch = false;
  const replayStartedAt = performance.now();
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (hardMismatch) {
      const last = mismatches[mismatches.length - 1];
      throw new Error(
        `replay already mismatched: ${last?.message ?? "unknown"}`,
      );
    }

    const fetchStartedAt = performance.now();
    let dependency: Dependency | undefined;
    let method: string;
    let url: string;

    if (matching === "snapshot") {
      const attempt = await attemptFromFetchArgs(input, init);
      method = attempt.method;
      url = attempt.url;
      dependency = matchUnusedDependencySnapshot(unused, attempt);
    } else {
      const attempt = await attemptFromFetchArgs(input, init);
      method = attempt.method;
      url = attempt.url;
      const matched = matchExecutableAttempt(matching, unused, attempt);
      dependency = matched.dependency;
      if (matched.softMismatch) {
        mismatches.push(matched.softMismatch);
      }
    }

    if (!dependency) {
      const miss = dependencyMismatch(method, url);
      mismatches.push(miss);
      hardMismatch = true;
      throw new Error(miss.message);
    }

    unused.delete(dependency.seq);
    if (timing === "realtime") {
      await paceDependencyCompletion(
        dependency,
        replayStartedAt,
        fetchStartedAt,
        timingNotes,
      );
    }
    return responseFromDependency(storage, manifest, dependency);
  };

  return {
    restore: () => {
      globalThis.fetch = previousFetch;
    },
    takeMismatches: () => [...mismatches],
    hadHardMismatch: () => hardMismatch,
    takeTimingNotes: () => [...timingNotes],
  };
}
