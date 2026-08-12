import type { StorageProvider } from "@epok/core";
import type { FinalizedInteraction } from "./finalize.js";
import type { EmitWideEvent } from "./observe.js";

/**
 * Persist a finalized Interaction through the Storage Provider.
 * Fail-open: errors become diagnostics, never throw to callers that ignore them.
 */
export async function persistFinalizedInteraction(
  storage: StorageProvider,
  finalized: FinalizedInteraction,
  emit: EmitWideEvent | undefined,
  onPersisted?: () => void,
): Promise<boolean> {
  const interactionId = finalized.manifest.id;
  const manifestHash = finalized.manifest.integrity.manifestHash;
  try {
    for (const [hash, bytes] of Object.entries(finalized.externalObjects)) {
      await storage.putObject({ alg: "sha256", hash }, bytes);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(finalized.manifest));
    await storage.putManifest({
      id: finalized.manifest.id,
      specVersion: finalized.manifest.specVersion,
      manifestHash,
      bytes,
    });
    onPersisted?.();
    emit?.({
      type: "interaction_persisted",
      interactionId,
      manifestHash,
    });
    return true;
  } catch (err) {
    emit?.({
      type: "interaction_dropped",
      reason: "persist_failed",
      interactionId,
      cause: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
