import type { CasKey } from "./cas.js";
import { StorageError, type PutManifestInput } from "./storage.js";

/** Sync SHA-256 hex digester supplied by the Storage Provider runtime. */
export type Sha256HexFn = (bytes: Uint8Array) => string;

interface ManifestClosureShape {
  objects?: Record<string, unknown>;
  integrity?: {
    manifestHash?: unknown;
    objects?: unknown;
  };
}

interface IntegrityObjectEntry {
  alg: "sha256";
  hash: string;
  size: number;
}

interface EmbeddedObjectShape {
  encoding: "utf-8" | "base64";
  data: string;
}

/** Verify `key.hash` matches `bytes` for sha256 CAS keys. */
export function assertCasObjectIntegrity(
  key: CasKey,
  bytes: Uint8Array,
  sha256Hex: Sha256HexFn,
): void {
  const actual = sha256Hex(bytes);
  if (actual !== key.hash) {
    throw new StorageError(
      "integrity",
      `CAS hash mismatch: expected ${key.hash}, got ${actual}`,
    );
  }
}

function parseManifestJson(bytes: Uint8Array): ManifestClosureShape {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ManifestClosureShape;
  } catch {
    throw new StorageError("integrity", "manifest bytes are not valid JSON");
  }
}

function isIntegrityObjectEntry(entry: unknown): entry is IntegrityObjectEntry {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return (
    record["alg"] === "sha256" &&
    typeof record["hash"] === "string" &&
    typeof record["size"] === "number"
  );
}

function decodeEmbeddedObject(value: unknown, hash: string): Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new StorageError(
      "integrity",
      `embedded object malformed for hash ${hash}`,
    );
  }
  const record = value as Record<string, unknown>;
  const encoding = record["encoding"];
  const data = record["data"];
  if (
    (encoding !== "utf-8" && encoding !== "base64") ||
    typeof data !== "string"
  ) {
    throw new StorageError(
      "integrity",
      `embedded object malformed for hash ${hash}`,
    );
  }
  const embedded: EmbeddedObjectShape = { encoding, data };
  if (embedded.encoding === "utf-8") {
    return new TextEncoder().encode(embedded.data);
  }
  try {
    const binary = atob(embedded.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new StorageError(
      "integrity",
      `embedded object base64 decode failed for hash ${hash}`,
    );
  }
}

function requiredClosureEntries(
  integrity: NonNullable<ManifestClosureShape["integrity"]>,
): IntegrityObjectEntry[] {
  const required = integrity.objects;
  if (!Array.isArray(required)) {
    throw new StorageError(
      "integrity",
      "manifest integrity.objects must be an array",
    );
  }

  const entries: IntegrityObjectEntry[] = [];
  for (const entry of required) {
    if (!isIntegrityObjectEntry(entry)) {
      throw new StorageError(
        "integrity",
        "manifest integrity.objects entry is malformed",
      );
    }
    entries.push(entry);
  }
  return entries;
}

function assertEmbeddedObjectIntegrity(
  entry: IntegrityObjectEntry,
  embeddedValue: unknown,
  sha256Hex: Sha256HexFn,
): void {
  const bytes = decodeEmbeddedObject(embeddedValue, entry.hash);
  if (bytes.byteLength !== entry.size) {
    throw new StorageError(
      "integrity",
      `embedded object size mismatch for hash ${entry.hash}`,
    );
  }
  assertCasObjectIntegrity(
    { alg: entry.alg, hash: entry.hash },
    bytes,
    sha256Hex,
  );
}

/**
 * Enforce putManifest atomicity: every `integrity.objects` entry must be
 * embedded in the manifest (with matching hash/size) or already present in
 * CAS storage.
 */
export async function assertManifestCasClosure(
  input: PutManifestInput,
  hasObject: (key: CasKey) => Promise<boolean>,
  sha256Hex: Sha256HexFn,
): Promise<void> {
  const parsed = parseManifestJson(input.bytes);
  const integrity = parsed.integrity;
  if (!integrity || integrity.manifestHash !== input.manifestHash) {
    throw new StorageError(
      "integrity",
      "putManifest manifestHash does not match integrity.manifestHash",
    );
  }

  const embedded = parsed.objects ?? {};
  for (const entry of requiredClosureEntries(integrity)) {
    if (Object.prototype.hasOwnProperty.call(embedded, entry.hash)) {
      assertEmbeddedObjectIntegrity(entry, embedded[entry.hash], sha256Hex);
      continue;
    }
    const present = await hasObject({ alg: entry.alg, hash: entry.hash });
    if (!present) {
      throw new StorageError(
        "integrity",
        `required CAS object missing: sha256:${entry.hash}`,
      );
    }
  }
}
