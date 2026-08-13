import {
  StorageError,
  type CasRef,
  type EmbeddedObject,
  type HeaderField,
  type InteractionManifest,
  type StorageProvider,
} from "@epok/core";
import { INBOUND_RESPONSE_MISSING_MESSAGE } from "./incomplete.js";

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

export function headersFromFields(fields: readonly HeaderField[]): Headers {
  const headers = new Headers();
  for (const field of fields) {
    headers.append(field.name, field.value);
  }
  return headers;
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

/** Materialize the recorded inbound Request from an Interaction. */
export async function buildInboundRequest(
  storage: StorageProvider,
  manifest: InteractionManifest,
): Promise<Request> {
  const body = await resolveCasBytes(
    storage,
    manifest,
    manifest.inbound.body.cas,
  );
  const init: RequestInit = {
    method: manifest.inbound.method,
    headers: headersFromFields(manifest.inbound.headers),
  };
  const method = manifest.inbound.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && body.byteLength > 0) {
    init.body = Uint8Array.from(body);
  }
  return new Request(manifest.inbound.url, init);
}

/** Materialize the recorded terminal Response fixture from an Interaction. */
export async function buildRecordedResponse(
  storage: StorageProvider,
  manifest: InteractionManifest,
): Promise<Response> {
  if (manifest.response === null) {
    throw new Error(INBOUND_RESPONSE_MISSING_MESSAGE);
  }
  const body = await resolveCasBytes(
    storage,
    manifest,
    manifest.response.body.cas,
  );
  const init: ResponseInit = {
    status: manifest.response.status,
    headers: headersFromFields(manifest.response.headers),
  };
  if (manifest.response.statusText !== undefined) {
    init.statusText = manifest.response.statusText;
  }
  return new Response(Uint8Array.from(body), init);
}
