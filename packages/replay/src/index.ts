import type { InteractionManifest, StorageProvider } from "@epok/core";

export type { InteractionManifest, StorageProvider };

export type {
  ReplayMismatch,
  ReplayMismatchMode,
  ReplayPlaybackMode,
  ReplayResult,
  ReplayTimingMode,
} from "./types.js";

export { runReplay } from "./run.js";
export type { ReplayHandler, ReplayRunOptions } from "./run.js";
export type { ReplaySecrets } from "./signatures.js";

export { mockReplay } from "./mock.js";
export type {
  MockReplayOptions,
  MockReplayReady,
  MockReplayResult,
} from "./mock.js";

export { validateReplay } from "./validate.js";
export type { ReplayValidateOptions } from "./validate.js";
