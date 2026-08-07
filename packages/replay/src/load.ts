import {
  StorageError,
  type CasRef,
  type EmbeddedObject,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";

function decodeEmbedded(embedded: EmbeddedObject): Uint8Array {
  if (embedded.encoding === "utf-8") {
    return new TextEncoder().encode(embedded.data);
  }
  const binary = atob(embedded.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Load Interaction manifest JSON bytes from a Storage Provider. */
export async function loadManifest(
  storage: StorageProvider,
  interactionId: string,
): Promise<InteractionManifest> {
  let bytes: Uint8Array;
  try {
    bytes = await storage.getManifest(interactionId);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      "unavailable",
      `failed to load Interaction ${interactionId}`,
    );
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as InteractionManifest;
  } catch {
    throw new StorageError(
      "integrity",
      `Interaction ${interactionId} manifest is not valid JSON`,
    );
  }
}

/** Resolve CAS body bytes from embedded objects or Storage Provider. */
export async function resolveCasBytes(
  storage: StorageProvider,
  manifest: InteractionManifest,
  ref: CasRef,
): Promise<Uint8Array> {
  const embedded = manifest.objects[ref.hash];
  if (embedded !== undefined) {
    return decodeEmbedded(embedded);
  }
  return storage.getObject({ alg: ref.alg, hash: ref.hash });
}
