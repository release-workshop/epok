import {
  matchDependency,
  type Dependency,
  type HeaderField,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";
import { resolveCasBytes } from "./load.js";
import type { ReplayMismatch } from "./types.js";

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

export function headersFromFields(fields: readonly HeaderField[]): Headers {
  const headers = new Headers();
  for (const field of fields) {
    headers.append(field.name, field.value);
  }
  return headers;
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
function matchUnusedDependency(
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

/**
 * Install a `fetch` interceptor that injects recorded dependency responses.
 * Instant timing: responses resolve as soon as matching succeeds.
 * Never forwards to the prior `fetch` (no external network).
 */
export function installDependencyInjection(options: {
  storage: StorageProvider;
  manifest: InteractionManifest;
}): FetchInjection {
  const { storage, manifest } = options;
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

    const method = requestMethod(input, init);
    const url = requestUrl(input);
    const dependency = matchUnusedDependency(unused, { method, url });

    if (!dependency) {
      mismatch = {
        code: "dependency_mismatch",
        message: `no recorded dependency for ${method} ${url}`,
        method,
        url,
      };
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
