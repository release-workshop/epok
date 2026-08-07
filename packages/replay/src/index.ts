import { matchDependency } from "@epok/core";
import type { InteractionManifest, StorageProvider } from "@epok/core";

export { matchDependency };
export type { InteractionManifest, StorageProvider };

export type {
  ReplayMismatch,
  ReplayMismatchMode,
  ReplayResult,
  ReplayTimingMode,
} from "./types.js";

export { runReplay } from "./run.js";
export type { ReplayHandler, ReplayRunOptions } from "./run.js";

export { validateReplay } from "./validate.js";
export type { ReplayValidateOptions } from "./validate.js";
