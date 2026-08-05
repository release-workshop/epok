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

export { matchDependency, matchKeyFromDependency } from "./replay.js";
export type { ReplayMatchKey, ReplayMatchOptions } from "./replay.js";

export type {
  DependencyObservationError,
  FetchLike,
  RecorderObservationHooks,
} from "./observation.js";
