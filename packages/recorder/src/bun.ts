import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import {
  attachWorkersRecorder,
  type AttachWorkersRecorderOptions,
  type WorkersFetchHandler,
  type WorkersRecorderHandle,
} from "./workers.js";

export type { CaptureMode } from "./capture-mode.js";
export type { RecorderObservationHooks, StorageProvider };
export type { RecorderWideEvent } from "./events.js";
export type { RecorderPressureLimits } from "./pressure.js";

/** Fetch-shaped handler type for Bun.serve and WinterCG-compatible Bun HTTP. */
export type BunFetchHandler = WorkersFetchHandler;

export type AttachBunRecorderOptions = Omit<
  AttachWorkersRecorderOptions,
  "runtime"
>;

export type BunRecorderHandle = WorkersRecorderHandle;

declare global {
  // Bun global when running under the Bun runtime.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Bun {
    const version: string;
  }
}

function bunRuntimeVersion(): string {
  if (typeof globalThis.Bun !== "undefined") {
    return globalThis.Bun.version;
  }
  return "unknown";
}

/**
 * Attach Epok recording for Bun Fetch-shaped HTTP handlers.
 * Reuses the Workers Fetch attach path (inbound Request + outbound fetch).
 * Requires AsyncLocalStorage (native on Bun) for request-scoped context.
 */
export function attachBunRecorder(
  options: AttachBunRecorderOptions,
): BunRecorderHandle {
  return attachWorkersRecorder({
    ...options,
    runtime: { name: "bun", version: bunRuntimeVersion() },
  });
}
