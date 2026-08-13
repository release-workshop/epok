/** Interaction format semver shipped by this package revision. */
export const SPEC_VERSION = "1.0.0" as const;

export type SpecVersion = typeof SPEC_VERSION;

/** CAS algorithm supported in v1. */
export type CasAlgorithm = "sha256";

/** Reference to a content-addressed body payload (never inline bytes on the message). */
export interface CasRef {
  alg: CasAlgorithm;
  /** Lowercase hex digest of persisted sanitized bytes. */
  hash: string;
  /** Byte length of persisted sanitized bytes. */
  size: number;
  contentType: string | null;
  contentEncoding: string | null;
}

export interface BodySlot {
  cas: CasRef;
}

export interface HeaderField {
  name: string;
  value: string;
}

/** Shared HTTP message fields used by inbound, dependencies, and response. */
export interface HttpMessageBase {
  protocol: string;
  headers: HeaderField[];
  trailers?: HeaderField[];
  body: BodySlot;
}

export interface HttpRequestMessage extends HttpMessageBase {
  method: string;
  /** Full observed URL; query values may be sanitized. */
  url: string;
}

export interface HttpResponseMessage extends HttpMessageBase {
  status: number;
  statusText?: string;
}

export interface DependencyError {
  type: string;
  message: string;
}

export interface Dependency {
  /** Unique sequence id within this Interaction. */
  seq: number;
  parentSeq?: number;
  /** Monotonic offset from Interaction start (ms). */
  startedAt: number;
  /** Monotonic offset from Interaction start (ms). */
  endedAt: number;
  request: HttpRequestMessage;
  response: HttpResponseMessage | null;
  error?: DependencyError;
}

export interface InteractionResponse extends HttpResponseMessage {
  startedAt: number;
  endedAt: number;
}

export interface RecorderIdentity {
  name: string;
  version: string;
}

export interface RuntimeIdentity {
  name: string;
  version: string;
}

export interface SanitizerIdentity {
  version: string;
}

export interface RulesetIdentity {
  id: string;
  hash: string;
}

/** Required Interaction metadata (minimum per Interaction spec §7.1). */
export interface InteractionMetadata {
  capturedAt: string;
  recorder: RecorderIdentity;
  runtime: RuntimeIdentity;
  sanitizer: SanitizerIdentity;
  ruleset: RulesetIdentity;
  captureMode: string;
  service?: { name: string };
  environment?: string;
  region?: string;
  hostname?: string;
  deployment?: { id: string };
}

export interface SignatureHint {
  target: string;
  algorithm: string;
  payload: string;
  /** Symbolic local secret name; never a secret value. */
  secretRef: string;
  replaced: boolean;
}

export interface ReplayHints {
  signatures: SignatureHint[];
}

/** Embedded small CAS payloads (`encoding` is `utf-8` or `base64` in v1). */
export interface EmbeddedObject {
  encoding: "utf-8" | "base64";
  data: string;
}

export interface IntegrityObjectEntry {
  alg: CasAlgorithm;
  hash: string;
  size: number;
}

export interface Integrity {
  /** SHA-256 of canonicalized manifest bytes with integrity self-reference omitted/zeroed. */
  manifestHash: string;
  objects: IntegrityObjectEntry[];
  recorderSignature?: string;
}

/**
 * Canonical Interaction manifest: one inbound HTTP execution plus outbound dependencies.
 * Bodies are CAS references; bytes live in `objects` or a Storage Provider.
 */
export interface InteractionManifest {
  /** RFC 9562 UUIDv7. */
  id: string;
  /** Open string so readers can accept unknown future versions. */
  specVersion: string;
  metadata: InteractionMetadata;
  inbound: HttpRequestMessage;
  dependencies: Dependency[];
  /** Null when inbound terminal was not observed (abort / close without finish). */
  response: InteractionResponse | null;
  replay: ReplayHints;
  objects: Record<string, EmbeddedObject>;
  integrity: Integrity;
}
