import { StorageError, type StorageProvider } from "@epok/core";
import { unsupportedSpecVersionMessage } from "./compat.js";
import { loadManifest, resolveCasBytes } from "./load.js";
import type { ReplayResult } from "./types.js";

export interface ReplayValidateOptions {
  storage: StorageProvider;
  interactionId: string;
}

/**
 * Integrity + compatibility validation without executing the app path.
 */
export async function validateReplay(
  options: ReplayValidateOptions,
): Promise<ReplayResult> {
  const manifest = await loadManifest(options.storage, options.interactionId);

  const versionError = unsupportedSpecVersionMessage(manifest.specVersion);
  if (versionError) {
    return {
      ok: false,
      interactionId: manifest.id,
      message: versionError,
    };
  }

  try {
    for (const entry of manifest.integrity.objects) {
      await resolveCasBytes(options.storage, manifest, {
        alg: entry.alg,
        hash: entry.hash,
        size: entry.size,
        contentType: null,
        contentEncoding: null,
      });
    }
  } catch (err) {
    const message =
      err instanceof StorageError
        ? err.message
        : err instanceof Error
          ? err.message
          : "CAS closure check failed";
    return {
      ok: false,
      interactionId: manifest.id,
      message,
    };
  }

  return {
    ok: true,
    interactionId: manifest.id,
    message: "Interaction integrity and compatibility checks passed",
  };
}
