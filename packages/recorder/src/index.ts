import type {
  RecorderObservationHooks,
  StorageProvider,
} from "@epok/core";

export type { RecorderObservationHooks, StorageProvider };

/**
 * Options for attaching the recorder to a Node HTTP server.
 * Node-only types stay in this package; observation uses Fetch-shaped hooks from `@epok/core`.
 */
export interface AttachRecorderOptions {
  storage: StorageProvider;
  hooks?: RecorderObservationHooks;
}

export interface RecorderHandle {
  detach(): void;
}

/**
 * Attach Epok recording to the current Node process.
 * Implementation lands in later slices; this export locks the package seam.
 */
export function attachRecorder(
  _options: AttachRecorderOptions,
): RecorderHandle {
  throw new Error("@epok/recorder: attachRecorder is not implemented yet");
}
