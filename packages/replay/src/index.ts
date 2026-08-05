import type { InteractionManifest, StorageProvider } from "@epok/core";
import { matchDependency } from "@epok/core";

export { matchDependency };
export type { InteractionManifest, StorageProvider };

export type ReplayTimingMode = "instant";
export type ReplayMismatchMode = "strict";

export interface ReplayRunOptions {
  storage: StorageProvider;
  interactionId: string;
  timing?: ReplayTimingMode;
  mode?: ReplayMismatchMode;
}

export interface ReplayValidateOptions {
  storage: StorageProvider;
  interactionId: string;
}

export interface ReplayResult {
  ok: boolean;
  interactionId: string;
  message: string;
}

/**
 * Executable re-run entry point (strict + instant in MVP).
 * Implementation lands in the replay spine slice.
 */
export async function runReplay(_options: ReplayRunOptions): Promise<ReplayResult> {
  throw new Error("@epok/replay: runReplay is not implemented yet");
}

/**
 * Integrity + compatibility validation without executing the app path.
 */
export async function validateReplay(
  _options: ReplayValidateOptions,
): Promise<ReplayResult> {
  throw new Error("@epok/replay: validateReplay is not implemented yet");
}
