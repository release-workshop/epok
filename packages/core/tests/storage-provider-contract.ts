import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CasKey,
  PutManifestInput,
  StorageProvider,
} from "../src/index.js";

export interface StorageProviderContractSetup {
  provider: StorageProvider;
  cleanup?: () => Promise<void> | void;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function casKeyFor(bytes: Uint8Array): CasKey {
  return { alg: "sha256", hash: sha256Hex(bytes) };
}

/** Minimal manifest bytes exercising embedded + external CAS closure. */
function buildManifestPackage(options: {
  id: string;
  embeddedBytes?: Uint8Array;
  externalBytes?: Uint8Array;
}): {
  input: PutManifestInput;
  externalKey?: CasKey;
  externalBytes?: Uint8Array;
} {
  const objects: Record<string, { encoding: "utf-8"; data: string }> = {};
  const integrityObjects: Array<{ alg: "sha256"; hash: string; size: number }> =
    [];

  if (options.embeddedBytes) {
    const hash = sha256Hex(options.embeddedBytes);
    objects[hash] = {
      encoding: "utf-8",
      data: new TextDecoder().decode(options.embeddedBytes),
    };
    integrityObjects.push({
      alg: "sha256",
      hash,
      size: options.embeddedBytes.byteLength,
    });
  }

  let externalKey: CasKey | undefined;
  if (options.externalBytes) {
    externalKey = casKeyFor(options.externalBytes);
    integrityObjects.push({
      alg: "sha256",
      hash: externalKey.hash,
      size: options.externalBytes.byteLength,
    });
  }

  const manifestHash = sha256Hex(
    new TextEncoder().encode(`manifest:${options.id}`),
  );
  const manifest = {
    id: options.id,
    specVersion: "1.0.0",
    objects,
    integrity: { manifestHash, objects: integrityObjects },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));

  return {
    input: {
      id: options.id,
      specVersion: "1.0.0",
      manifestHash,
      bytes,
    },
    externalKey,
    externalBytes: options.externalBytes,
  };
}

/**
 * Shared Storage Provider behavior suite. Run against every implementation so
 * the seam stays interchangeable (filesystem, memory, future remote).
 */
export function describeStorageProviderContract(
  label: string,
  setup: () =>
    StorageProviderContractSetup | Promise<StorageProviderContractSetup>,
): void {
  describe(`StorageProvider (${label})`, () => {
    let provider: StorageProvider;
    let cleanup: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const ctx = await setup();
      provider = ctx.provider;
      cleanup = ctx.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it("stores and retrieves a CAS object by key", async () => {
      const bytes = new TextEncoder().encode("hello-cas");
      const key = casKeyFor(bytes);

      const result = await provider.putObject(key, bytes);
      expect(result.created).toBe(true);
      expect(await provider.hasObject(key)).toBe(true);
      expect(await provider.getObject(key)).toEqual(bytes);
    });

    it("rejects putObject when key.hash does not match bytes", async () => {
      const bytes = new TextEncoder().encode("hello-cas");
      const key: CasKey = {
        alg: "sha256",
        hash: "0".repeat(64),
      };

      await expect(provider.putObject(key, bytes)).rejects.toMatchObject({
        name: "StorageError",
        code: "integrity",
      });
      expect(await provider.hasObject(key)).toBe(false);
    });

    it("treats putObject as idempotent for the same hash", async () => {
      const bytes = new TextEncoder().encode("same-bytes");
      const key = casKeyFor(bytes);

      expect(await provider.putObject(key, bytes)).toEqual({ created: true });
      expect(await provider.putObject(key, bytes)).toEqual({ created: false });
      expect(await provider.getObject(key)).toEqual(bytes);
    });

    it("returns not_found for missing manifest and CAS object", async () => {
      await expect(provider.getManifest("missing-id")).rejects.toMatchObject({
        name: "StorageError",
        code: "not_found",
      });
      await expect(
        provider.getObject({ alg: "sha256", hash: "a".repeat(64) }),
      ).rejects.toMatchObject({
        name: "StorageError",
        code: "not_found",
      });
      expect(
        await provider.hasObject({ alg: "sha256", hash: "a".repeat(64) }),
      ).toBe(false);
    });

    it("rejects putManifest when required external CAS objects are missing", async () => {
      const pkg = buildManifestPackage({
        id: "01900000-0000-7000-8000-000000000010",
        externalBytes: new TextEncoder().encode("large-body-payload"),
      });

      await expect(provider.putManifest(pkg.input)).rejects.toMatchObject({
        name: "StorageError",
        code: "integrity",
      });
      await expect(provider.getManifest(pkg.input.id)).rejects.toMatchObject({
        name: "StorageError",
        code: "not_found",
      });
    });

    it("rejects putManifest when an embedded object fails hash integrity", async () => {
      const id = "01900000-0000-7000-8000-000000000012";
      const realBytes = new TextEncoder().encode("honest-bytes");
      const hash = sha256Hex(realBytes);
      const manifestHash = sha256Hex(
        new TextEncoder().encode(`manifest:${id}`),
      );
      const manifest = {
        id,
        specVersion: "1.0.0",
        objects: {
          [hash]: { encoding: "utf-8", data: "tampered-bytes" },
        },
        integrity: {
          manifestHash,
          objects: [{ alg: "sha256", hash, size: realBytes.byteLength }],
        },
      };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));

      await expect(
        provider.putManifest({
          id,
          specVersion: "1.0.0",
          manifestHash,
          bytes,
        }),
      ).rejects.toMatchObject({
        name: "StorageError",
        code: "integrity",
      });
    });

    it("persists a manifest once CAS closure is present and reloads intact", async () => {
      const embeddedBytes = new TextEncoder().encode("small-embedded");
      const externalBytes = new TextEncoder().encode("external-cas-bytes");
      const pkg = buildManifestPackage({
        id: "01900000-0000-7000-8000-000000000011",
        embeddedBytes,
        externalBytes,
      });

      const externalKey = pkg.externalKey;
      const externalObjectBytes = pkg.externalBytes;
      if (!externalKey || !externalObjectBytes) {
        throw new Error("fixture must include external CAS bytes");
      }

      await provider.putObject(externalKey, externalObjectBytes);
      await provider.putManifest(pkg.input);

      const loaded = await provider.getManifest(pkg.input.id);
      expect(loaded).toEqual(pkg.input.bytes);

      const parsed = JSON.parse(new TextDecoder().decode(loaded)) as {
        objects: Record<string, unknown>;
        integrity: {
          manifestHash: string;
          objects: Array<{ alg: "sha256"; hash: string; size: number }>;
        };
      };
      expect(parsed.integrity.manifestHash).toBe(pkg.input.manifestHash);

      for (const entry of parsed.integrity.objects) {
        const embedded = parsed.objects[entry.hash];
        if (embedded !== undefined) {
          expect(embedded).toEqual({
            encoding: "utf-8",
            data: new TextDecoder().decode(embeddedBytes),
          });
          continue;
        }
        const bytes = await provider.getObject({
          alg: entry.alg,
          hash: entry.hash,
        });
        expect(bytes).toEqual(externalBytes);
        expect(sha256Hex(bytes)).toBe(entry.hash);
        expect(bytes.byteLength).toBe(entry.size);
      }
    });
  });
}
