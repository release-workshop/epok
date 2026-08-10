export { SPEC_VERSION } from "./interaction.js";
export type {
  BodySlot,
  CasAlgorithm,
  CasRef,
  Dependency,
  DependencyError,
  EmbeddedObject,
  HeaderField,
  HttpMessageBase,
  HttpRequestMessage,
  HttpResponseMessage,
  Integrity,
  IntegrityObjectEntry,
  InteractionManifest,
  InteractionMetadata,
  InteractionResponse,
  RecorderIdentity,
  ReplayHints,
  RulesetIdentity,
  RuntimeIdentity,
  SanitizerIdentity,
  SignatureHint,
  SpecVersion,
} from "./interaction.js";

export {
  EMBEDDED_OBJECT_MAX_BYTES,
  casKeyFromRef,
  mayEmbedObject,
} from "./cas.js";
export type { CasKey } from "./cas.js";

export { StorageError } from "./storage.js";
export type {
  PutManifestInput,
  PutObjectResult,
  StorageErrorCode,
  StorageProvider,
} from "./storage.js";

export {
  assertCasObjectIntegrity,
  assertManifestCasClosure,
} from "./storage-verify.js";
export type { Sha256HexFn } from "./storage-verify.js";

export {
  matchDependency,
  matchKeyFromDependency,
  matchSnapshotDependency,
} from "./replay.js";
export type {
  ReplayMatchKey,
  ReplayMatchOptions,
  SnapshotMatchAttempt,
} from "./replay.js";

export type {
  DependencyObservationError,
  FetchLike,
  RecorderObservationHooks,
} from "./observation.js";

export { REDACTION_SENTINEL, createSanitizer } from "./sanitize.js";
export type {
  CreateSanitizerOptions,
  SanitizeMessageInput,
  SanitizeMessageResult,
  Sanitizer,
  SanitizerPackId,
  SanitizerRule,
} from "./sanitize.js";
