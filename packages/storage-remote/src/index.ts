import { createHash } from "node:crypto";
import {
  StorageError,
  assertCasObjectIntegrity,
  assertManifestCasClosure,
  type CasKey,
  type PutManifestInput,
  type PutObjectResult,
  type StorageErrorCode,
  type StorageProvider,
} from "@epok/core";

export interface RemoteStorageProviderOptions {
  /**
   * Explicit remote Storage Provider base URL.
   * Required — this package embeds no default commercial hostname.
   * Path prefixes on the endpoint are preserved (e.g. `https://host/epok`).
   */
  endpoint: string;
  /** Optional caller-supplied headers (for example Authorization). */
  headers?: HeadersInit;
  /** Optional fetch implementation; defaults to global `fetch`. */
  fetch?: typeof fetch;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new TypeError(
      "createRemoteStorageProvider requires an explicit endpoint URL",
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function objectPath(key: CasKey): string {
  return `objects/${encodeURIComponent(key.alg)}/${encodeURIComponent(key.hash)}`;
}

function manifestPath(id: string): string {
  return `manifests/${encodeURIComponent(id)}`;
}

/** Join a relative persistence path onto an operator-configured endpoint. */
function endpointUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base);
}

const STATUS_ERROR_CODES: ReadonlyArray<readonly [number, StorageErrorCode]> = [
  [404, "not_found"],
  [401, "unauthorized"],
  [403, "unauthorized"],
  [408, "timeout"],
  [504, "timeout"],
  [429, "quota"],
  [507, "quota"],
  [422, "integrity"],
  [409, "integrity"],
];

const KNOWN_ERROR_CODES = new Set<string>([
  "unavailable",
  "timeout",
  "quota",
  "integrity",
  "not_found",
  "unauthorized",
]);

function storageErrorFromResponse(
  res: Response,
  fallbackMessage: string,
): StorageError {
  const headerCode = res.headers.get("x-epok-storage-error");
  if (headerCode && KNOWN_ERROR_CODES.has(headerCode)) {
    return new StorageError(headerCode as StorageErrorCode, fallbackMessage);
  }
  for (const [status, code] of STATUS_ERROR_CODES) {
    if (res.status === status) {
      return new StorageError(code, fallbackMessage);
    }
  }
  return new StorageError("unavailable", fallbackMessage);
}

async function parsePutObjectResult(res: Response): Promise<PutObjectResult> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = (await res.json()) as { created?: unknown };
    if (typeof parsed.created === "boolean") {
      return { created: parsed.created };
    }
  }
  // 201 = created; other success statuses treat as idempotent hit.
  return { created: res.status === 201 };
}

type RemoteRequest = (
  method: string,
  path: string,
  init?: {
    body?: Uint8Array;
    headers?: Record<string, string>;
  },
) => Promise<Response>;

function createRemoteRequest(
  baseUrl: string,
  fetchFn: typeof fetch,
  staticHeaders: HeadersInit | undefined,
): RemoteRequest {
  return async (method, path, init) => {
    const headers = new Headers(staticHeaders);
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers)) {
        headers.set(key, value);
      }
    }
    const requestInit: RequestInit = { method, headers };
    if (init?.body) {
      // Buffer is a valid BodyInit; keeps exactOptionalPropertyTypes happy.
      requestInit.body = Buffer.from(init.body);
    }
    try {
      return await fetchFn(endpointUrl(baseUrl, path), requestInit);
    } catch (err) {
      throw new StorageError(
        "unavailable",
        err instanceof Error ? err.message : "remote storage request failed",
      );
    }
  };
}

/**
 * Create an opaque remote Storage Provider client.
 * Speaks persistence-only HTTP against an operator-configured endpoint.
 *
 * Wire protocol (relative to `endpoint`):
 * - `PUT|GET manifests/:id`
 * - `PUT|GET|HEAD objects/:alg/:hash`
 */
export function createRemoteStorageProvider(
  options: RemoteStorageProviderOptions,
): StorageProvider {
  const baseUrl = normalizeEndpoint(options.endpoint);
  const request = createRemoteRequest(
    baseUrl,
    options.fetch ?? fetch,
    options.headers,
  );

  const hasObject = async (key: CasKey): Promise<boolean> => {
    const res = await request("HEAD", objectPath(key));
    if (res.status === 200) {
      return true;
    }
    if (res.status === 404) {
      return false;
    }
    throw storageErrorFromResponse(
      res,
      `hasObject failed for ${key.alg}:${key.hash}`,
    );
  };

  return {
    durability: "durable",

    async putManifest(input: PutManifestInput): Promise<void> {
      await assertManifestCasClosure(input, hasObject, sha256Hex);
      const res = await request("PUT", manifestPath(input.id), {
        body: input.bytes,
        headers: {
          "content-type": "application/octet-stream",
          "x-epok-spec-version": input.specVersion,
          "x-epok-manifest-hash": input.manifestHash,
        },
      });
      if (!res.ok) {
        throw storageErrorFromResponse(
          res,
          `putManifest failed for ${input.id}`,
        );
      }
    },

    async getManifest(id: string): Promise<Uint8Array> {
      const res = await request("GET", manifestPath(id));
      if (!res.ok) {
        throw storageErrorFromResponse(res, `manifest not found: ${id}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async putObject(key: CasKey, bytes: Uint8Array): Promise<PutObjectResult> {
      assertCasObjectIntegrity(key, bytes, sha256Hex);
      const res = await request("PUT", objectPath(key), {
        body: bytes,
        headers: {
          "content-type": "application/octet-stream",
        },
      });
      if (!res.ok) {
        throw storageErrorFromResponse(
          res,
          `putObject failed for ${key.alg}:${key.hash}`,
        );
      }
      return parsePutObjectResult(res);
    },

    async getObject(key: CasKey): Promise<Uint8Array> {
      const res = await request("GET", objectPath(key));
      if (!res.ok) {
        throw storageErrorFromResponse(
          res,
          `CAS object not found: ${key.alg}:${key.hash}`,
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      assertCasObjectIntegrity(key, bytes, sha256Hex);
      return bytes;
    },

    hasObject,
  };
}
