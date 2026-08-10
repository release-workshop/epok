import {
  matchDependency,
  matchSnapshotDependency,
  type Dependency,
  type HeaderField,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";
import { createHash } from "node:crypto";
import { headersFromFields, resolveCasBytes } from "./load.js";
import type { ReplayMismatch } from "./types.js";

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
 * Strict match among unused rows: method + URL, with `seq` when retries share a key.
 */
function matchUnusedDependencyStrict(
  unused: ReadonlyMap<number, Dependency>,
  attempt: { method: string; url: string },
): Dependency | undefined {
  const pool = [...unused.values()];
  const normalized = pool.map(withUpperMethod);
  const sameKey = normalized
    .filter(
      (dep) =>
        dep.request.method === attempt.method &&
        dep.request.url === attempt.url,
    )
    .sort((a, b) => a.seq - b.seq);

  if (sameKey.length === 0) return undefined;

  const next = sameKey[0];
  if (next === undefined) return undefined;

  const matched = matchDependency(
    normalized,
    attempt,
    sameKey.length > 1 ? { seq: next.seq } : undefined,
  );
  if (!matched) return undefined;
  return unused.get(matched.seq);
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
  takeMismatch: () => ReplayMismatch | undefined;
}

export type DependencyMatchMode = "strict" | "snapshot";

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

/**
 * Install a `fetch` interceptor that injects recorded dependency responses.
 * Instant timing: responses resolve as soon as matching succeeds.
 * Never forwards to the prior `fetch` (no external network).
 */
export function installDependencyInjection(options: {
  storage: StorageProvider;
  manifest: InteractionManifest;
  matching?: DependencyMatchMode;
}): FetchInjection {
  const { storage, manifest } = options;
  const matching: DependencyMatchMode = options.matching ?? "strict";
  const unused = new Map(
    manifest.dependencies.map((dep) => [dep.seq, dep] as const),
  );
  let mismatch: ReplayMismatch | undefined;
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (mismatch) {
      throw new Error(`replay already mismatched: ${mismatch.message}`);
    }

    let dependency: Dependency | undefined;
    let method: string;
    let url: string;

    if (matching === "snapshot") {
      const attempt = await attemptFromFetchArgs(input, init);
      method = attempt.method;
      url = attempt.url;
      dependency = matchUnusedDependencySnapshot(unused, attempt);
    } else {
      method = requestMethod(input, init);
      url = requestUrl(input);
      dependency = matchUnusedDependencyStrict(unused, { method, url });
    }

    if (!dependency) {
      mismatch = dependencyMismatch(method, url);
      throw new Error(mismatch.message);
    }

    unused.delete(dependency.seq);
    return responseFromDependency(storage, manifest, dependency);
  };

  return {
    restore: () => {
      globalThis.fetch = previousFetch;
    },
    takeMismatch: () => mismatch,
  };
}
