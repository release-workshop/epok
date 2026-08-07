import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StorageError,
  assertCasObjectIntegrity,
  assertManifestCasClosure,
  type CasKey,
  type PutManifestInput,
  type PutObjectResult,
  type StorageProvider,
} from "@epok/core";

export interface FsStorageProviderOptions {
  /** Directory root for manifests and CAS objects. */
  rootDir: string;
}

function objectStoreKey(key: CasKey): string {
  return `${key.alg}:${key.hash}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function writeFileAtomic(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Create a durable filesystem Storage Provider.
 */
export function createFsStorageProvider(
  options: FsStorageProviderOptions,
): StorageProvider {
  const rootDir = path.resolve(options.rootDir);
  const manifestsDir = path.join(rootDir, "manifests");
  const objectsDir = path.join(rootDir, "objects");

  function manifestPath(id: string): string {
    return path.join(manifestsDir, `${id}.json`);
  }

  function objectPath(key: CasKey): string {
    return path.join(objectsDir, key.alg, key.hash);
  }

  const hasObject = async (key: CasKey): Promise<boolean> =>
    pathExists(objectPath(key));

  return {
    durability: "durable",

    async putManifest(input: PutManifestInput): Promise<void> {
      await assertManifestCasClosure(input, hasObject, sha256Hex);
      await writeFileAtomic(manifestPath(input.id), input.bytes);
    },

    async getManifest(id: string): Promise<Uint8Array> {
      try {
        const buf = await readFile(manifestPath(id));
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new StorageError("not_found", `manifest not found: ${id}`);
        }
        throw err;
      }
    },

    async putObject(key: CasKey, bytes: Uint8Array): Promise<PutObjectResult> {
      assertCasObjectIntegrity(key, bytes, sha256Hex);
      const filePath = objectPath(key);
      if (await pathExists(filePath)) {
        return { created: false };
      }
      await writeFileAtomic(filePath, bytes);
      return { created: true };
    },

    async getObject(key: CasKey): Promise<Uint8Array> {
      try {
        const buf = await readFile(objectPath(key));
        const bytes = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        );
        assertCasObjectIntegrity(key, bytes, sha256Hex);
        return bytes;
      } catch (err) {
        if (err instanceof StorageError) {
          throw err;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new StorageError(
            "not_found",
            `CAS object not found: ${objectStoreKey(key)}`,
          );
        }
        throw err;
      }
    },

    hasObject,
  };
}
