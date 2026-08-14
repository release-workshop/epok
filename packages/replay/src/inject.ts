import {
  type Dependency,
  type HeaderField,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";
import { createHash } from "node:crypto";
import { headersFromFields, resolveCasBytes } from "./load.js";
import {
  MatchPool,
  type DependencyMatchMode,
  type OutboundMatchAttempt,
} from "./matching.js";
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

export type { DependencyMatchMode };

async function attemptFromFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<OutboundMatchAttempt> {
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
  const attempt: OutboundMatchAttempt = {
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
  const pool = new MatchPool(manifest.dependencies, matching);
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
    const attempt = await attemptFromFetchArgs(input, init);
    const matched = pool.match(attempt);
    const method = attempt.method;
    const url = attempt.url;

    if (matched?.softMismatch) {
      mismatches.push(matched.softMismatch);
    }

    if (!matched) {
      const miss = dependencyMismatch(method, url);
      mismatches.push(miss);
      hardMismatch = true;
      throw new Error(miss.message);
    }

    const dependency = matched.dependency;
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
