import type { CasKey } from "./cas.js";

/** Typed Storage Provider failure codes (Storage Provider spec §3). */
export type StorageErrorCode =
  | "unavailable"
  | "timeout"
  | "quota"
  | "integrity"
  | "not_found"
  | "unauthorized";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface PutManifestInput {
  id: string;
  specVersion: string;
  manifestHash: string;
  /** Sanitized manifest JSON bytes. */
  bytes: Uint8Array;
}

export interface PutObjectResult {
  /** False when the object already existed (idempotent write). */
  created: boolean;
}

/**
 * Persistence seam for Interaction manifests and CAS objects.
 * Implementations must remain async and must not require Node-only APIs in callers.
 */
export interface StorageProvider {
  /** Declared durability; RFC behavior assumes no stronger guarantee. */
  readonly durability: "best-effort" | "durable";

  /**
   * Publish a sanitized manifest. Implementations must not succeed if required
   * CAS objects for that Interaction are missing.
   */
  putManifest(input: PutManifestInput): Promise<void>;

  getManifest(id: string): Promise<Uint8Array>;

  /**
   * Store CAS bytes. Implementations must verify `key.hash` matches the bytes
   * and fail with `StorageError("integrity", …)` on mismatch. Idempotent for
   * the same hash.
   */
  putObject(key: CasKey, bytes: Uint8Array): Promise<PutObjectResult>;

  getObject(key: CasKey): Promise<Uint8Array>;

  hasObject(key: CasKey): Promise<boolean>;
}
