import { createHash } from "node:crypto";
import {
  SPEC_VERSION,
  createSanitizer,
  mayEmbedObject,
  type Dependency,
  type DependencyError,
  type EmbeddedObject,
  type HeaderField,
  type HttpRequestMessage,
  type HttpResponseMessage,
  type IntegrityObjectEntry,
  type InteractionManifest,
  type InteractionMetadata,
  type InteractionResponse,
  type RecorderIdentity,
  type RuntimeIdentity,
  type Sanitizer,
} from "@epok/core";
import type { RecorderWideEvent } from "./events.js";

export interface ObservedHttpMessage {
  protocol: string;
  headers: HeaderField[];
  body: Uint8Array;
  contentType?: string | null;
  contentEncoding?: string | null;
}

export interface ObservedHttpRequest extends ObservedHttpMessage {
  method: string;
  url: string;
}

export interface ObservedHttpResponse extends ObservedHttpMessage {
  status: number;
  statusText?: string;
}

export interface ObservedDependency {
  seq: number;
  parentSeq?: number;
  startedAt: number;
  endedAt: number;
  request: ObservedHttpRequest;
  response: ObservedHttpResponse | null;
  error?: DependencyError;
}

/** Pre-sanitize capture buffer ready for finalize. */
export interface ObservedCapture {
  id: string;
  capturedAt: string;
  inbound: ObservedHttpRequest;
  dependencies: readonly ObservedDependency[];
  response: ObservedHttpResponse & {
    startedAt: number;
    endedAt: number;
  };
  recorder?: RecorderIdentity;
  runtime?: RuntimeIdentity;
  captureMode?: string;
}

export interface FinalizedInteraction {
  manifest: InteractionManifest;
  /** Sanitized CAS bytes that exceed the embed threshold (hash → bytes). */
  externalObjects: Record<string, Uint8Array>;
}

export interface FinalizeObservationOptions {
  sanitizer?: Sanitizer;
  onEvent?: (event: RecorderWideEvent) => void;
}

const DEFAULT_RECORDER: RecorderIdentity = {
  name: "@epok/recorder",
  version: "0.0.0",
};

const DEFAULT_RUNTIME: RuntimeIdentity = {
  name: "node",
  version: process.versions.node,
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentTypeOf(
  headers: HeaderField[],
  explicit?: string | null,
): string | null {
  if (explicit !== undefined) return explicit;
  const hit = headers.find((h) => h.name.toLowerCase() === "content-type");
  return hit?.value ?? null;
}

function embedObject(bytes: Uint8Array): EmbeddedObject {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { encoding: "utf-8", data: text };
  } catch {
    return {
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
    };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function emitSafe(
  onEvent: FinalizeObservationOptions["onEvent"],
  event: RecorderWideEvent,
): void {
  try {
    onEvent?.(event);
  } catch {
    // Fail-open: diagnostics must never escape.
  }
}

interface CasPlacement {
  ref: {
    alg: "sha256";
    hash: string;
    size: number;
    contentType: string | null;
    contentEncoding: string | null;
  };
  embedded?: EmbeddedObject;
  external?: Uint8Array;
}

function placeSanitizedBody(
  bytes: Uint8Array,
  contentType: string | null,
  contentEncoding: string | null,
): CasPlacement {
  const hash = sha256Hex(bytes);
  const ref = {
    alg: "sha256" as const,
    hash,
    size: bytes.byteLength,
    contentType,
    contentEncoding,
  };
  if (mayEmbedObject(bytes.byteLength)) {
    return { ref, embedded: embedObject(bytes) };
  }
  return { ref, external: bytes };
}

interface ObjectAccumulator {
  objects: Record<string, EmbeddedObject>;
  externalObjects: Record<string, Uint8Array>;
  integrityObjects: IntegrityObjectEntry[];
}

function rememberPlacement(
  acc: ObjectAccumulator,
  placement: CasPlacement,
): void {
  acc.integrityObjects.push({
    alg: placement.ref.alg,
    hash: placement.ref.hash,
    size: placement.ref.size,
  });
  if (placement.embedded) {
    acc.objects[placement.ref.hash] = placement.embedded;
  }
  if (placement.external) {
    acc.externalObjects[placement.ref.hash] = placement.external;
  }
}

function sanitizeMessageParts(
  sanitizer: Sanitizer,
  message: ObservedHttpMessage,
  acc: ObjectAccumulator,
  url?: string,
): {
  protocol: string;
  headers: HeaderField[];
  url?: string;
  body: { cas: CasPlacement["ref"] };
} {
  const sanitized = sanitizer.sanitize({
    headers: message.headers,
    body: message.body,
    contentType: contentTypeOf(message.headers, message.contentType),
    ...(url !== undefined ? { url } : {}),
  });
  const placement = placeSanitizedBody(
    sanitized.body ?? new Uint8Array(),
    contentTypeOf(sanitized.headers, message.contentType),
    message.contentEncoding ?? null,
  );
  rememberPlacement(acc, placement);

  const parts: {
    protocol: string;
    headers: HeaderField[];
    url?: string;
    body: { cas: CasPlacement["ref"] };
  } = {
    protocol: message.protocol,
    headers: sanitized.headers,
    body: { cas: placement.ref },
  };
  if (url !== undefined && sanitized.url !== undefined) {
    parts.url = sanitized.url;
  }
  return parts;
}

function sanitizeRequestMessage(
  sanitizer: Sanitizer,
  request: ObservedHttpRequest,
  acc: ObjectAccumulator,
): HttpRequestMessage {
  const parts = sanitizeMessageParts(sanitizer, request, acc, request.url);
  if (parts.url === undefined) {
    throw new Error("sanitizer omitted request URL");
  }
  return {
    protocol: parts.protocol,
    method: request.method,
    url: parts.url,
    headers: parts.headers,
    body: parts.body,
  };
}

function sanitizeResponseMessage(
  sanitizer: Sanitizer,
  response: ObservedHttpResponse,
  acc: ObjectAccumulator,
): HttpResponseMessage {
  const parts = sanitizeMessageParts(sanitizer, response, acc);
  const message: HttpResponseMessage = {
    protocol: parts.protocol,
    status: response.status,
    headers: parts.headers,
    body: parts.body,
  };
  if (response.statusText !== undefined) {
    message.statusText = response.statusText;
  }
  return message;
}

function buildDependencies(
  sanitizer: Sanitizer,
  dependencies: readonly ObservedDependency[],
  acc: ObjectAccumulator,
): Dependency[] {
  return dependencies.map((dep) => {
    const row: Dependency = {
      seq: dep.seq,
      startedAt: dep.startedAt,
      endedAt: dep.endedAt,
      request: sanitizeRequestMessage(sanitizer, dep.request, acc),
      response: dep.response
        ? sanitizeResponseMessage(sanitizer, dep.response, acc)
        : null,
    };
    if (dep.parentSeq !== undefined) row.parentSeq = dep.parentSeq;
    if (dep.error !== undefined) row.error = dep.error;
    return row;
  });
}

function assembleManifest(input: {
  capture: ObservedCapture;
  sanitizer: Sanitizer;
  inbound: HttpRequestMessage;
  dependencies: Dependency[];
  response: InteractionResponse;
  objects: Record<string, EmbeddedObject>;
  integrityObjects: IntegrityObjectEntry[];
}): InteractionManifest {
  const {
    capture,
    sanitizer,
    inbound,
    dependencies,
    response,
    objects,
    integrityObjects,
  } = input;

  const metadata: InteractionMetadata = {
    capturedAt: capture.capturedAt,
    recorder: capture.recorder ?? DEFAULT_RECORDER,
    runtime: capture.runtime ?? DEFAULT_RUNTIME,
    sanitizer: sanitizer.identity,
    ruleset: sanitizer.ruleset,
    captureMode: capture.captureMode ?? "full",
  };

  const draft = {
    id: capture.id,
    specVersion: SPEC_VERSION,
    metadata,
    inbound,
    dependencies,
    response,
    replay: { signatures: [] },
    objects,
    integrity: {
      manifestHash: "",
      objects: integrityObjects,
    },
  };

  const manifestHash = sha256Hex(
    new TextEncoder().encode(stableStringify(draft)),
  );

  return {
    ...draft,
    integrity: {
      manifestHash,
      objects: integrityObjects,
    },
  };
}

/**
 * Sanitize observed capture bytes and assemble an immutable Interaction
 * manifest with CAS object references. Returns `null` (fail-open drop) when
 * sanitization cannot produce a safe artifact.
 */
export function finalizeObservation(
  capture: ObservedCapture,
  options: FinalizeObservationOptions = {},
): FinalizedInteraction | null {
  const sanitizer = options.sanitizer ?? createSanitizer();
  const acc: ObjectAccumulator = {
    objects: {},
    externalObjects: {},
    integrityObjects: [],
  };

  try {
    const inbound = sanitizeRequestMessage(sanitizer, capture.inbound, acc);
    const dependencies = buildDependencies(
      sanitizer,
      capture.dependencies,
      acc,
    );
    const responseMessage = sanitizeResponseMessage(
      sanitizer,
      capture.response,
      acc,
    );
    const response: InteractionResponse = {
      ...responseMessage,
      startedAt: capture.response.startedAt,
      endedAt: capture.response.endedAt,
    };

    const manifest = assembleManifest({
      capture,
      sanitizer,
      inbound,
      dependencies,
      response,
      objects: acc.objects,
      integrityObjects: acc.integrityObjects,
    });

    emitSafe(options.onEvent, {
      type: "interaction_finalized",
      interactionId: capture.id,
      manifestHash: manifest.integrity.manifestHash,
    });

    return { manifest, externalObjects: acc.externalObjects };
  } catch (err) {
    emitSafe(options.onEvent, {
      type: "interaction_dropped",
      reason: "sanitization_failed",
      interactionId: capture.id,
      cause: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
