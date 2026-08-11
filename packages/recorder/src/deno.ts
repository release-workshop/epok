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

/** Fetch-shaped handler type for Deno.serve and WinterCG-compatible Deno HTTP. */
export type DenoFetchHandler = WorkersFetchHandler;

export type AttachDenoRecorderOptions = Omit<
  AttachWorkersRecorderOptions,
  "runtime"
>;

export type DenoRecorderHandle = WorkersRecorderHandle;

declare global {
  // Deno global when running under the Deno runtime.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Deno {
    const version: { deno: string; v8: string; typescript: string };
  }
}

function denoRuntimeVersion(): string {
  if (typeof globalThis.Deno !== "undefined") {
    return globalThis.Deno.version.deno;
  }
  return "unknown";
}

/**
 * Attach Epok recording for Deno Fetch-shaped HTTP handlers.
 * Reuses the Workers Fetch attach path (inbound Request + outbound fetch).
 * Requires AsyncLocalStorage (available via node:async_hooks on Deno) for request-scoped context.
 */
export function attachDenoRecorder(
  options: AttachDenoRecorderOptions,
): DenoRecorderHandle {
  return attachWorkersRecorder({
    ...options,
    runtime: { name: "deno", version: denoRuntimeVersion() },
  });
}
