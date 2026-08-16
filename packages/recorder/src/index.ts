import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import { attachRuntimeOptions, createAttachRuntime } from "./attach-runtime.js";
import type { CaptureMode } from "./capture-mode.js";
import type { RecorderWideEvent } from "./events.js";
import { installInboundAttach } from "./inbound.js";
import type { RecorderPressureLimits } from "./pressure.js";
import type { RecorderStats } from "./stats.js";

export type { RecorderObservationHooks, StorageProvider };
export type { CaptureMode } from "./capture-mode.js";
export {
  DEFAULT_CAPTURE_MODE,
  shouldPersistInteraction,
} from "./capture-mode.js";
export type { RecorderWideEvent } from "./events.js";
export type { RecorderPressureLimits } from "./pressure.js";
export { DEFAULT_PRESSURE_LIMITS } from "./pressure.js";
export type { RecorderStats } from "./stats.js";
export { startStatsExporter, statsCounterDeltas } from "./stats-exporter.js";
export type {
  StartStatsExporterOptions,
  StatsCounterDeltas,
  StatsExporterHandle,
  StatsExporterSample,
} from "./stats-exporter.js";
export { finalizeObservation } from "./finalize.js";
export type {
  FinalizedInteraction,
  FinalizeObservationOptions,
  ObservedCapture,
  ObservedDependency,
  ObservedHttpMessage,
  ObservedHttpRequest,
  ObservedHttpResponse,
} from "./finalize.js";

/**
 * Options for attaching the recorder to a Node HTTP server.
 * Node-only types stay in this package; observation uses Fetch-shaped hooks from `@epok/core`.
 */
export interface AttachRecorderOptions {
  storage: StorageProvider;
  /**
   * When `false`, interception wrappers stay installed but capture, sanitize,
   * and persist are short-circuited (structural no-op baseline for overhead bars).
   * Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Persist intensity. Collect stays always-on when enabled.
   * - `"errors"` (default): sanitize/finalize/persist only on inbound status
   *   >= 500 or a terminal host exception.
   * - `"full"`: persist every completed Interaction (test-data / credibility).
   */
  captureMode?: CaptureMode;
  hooks?: RecorderObservationHooks;
  /** Wide structured recorder-ops events (opt-in). HTTP facts use `hooks`. */
  onEvent?: (event: RecorderWideEvent) => void;
  /**
   * Upper bounds for async sanitize/finalize/persist work and capture buffers.
   * Byte-budget pressure elides bodies by default; queue/context pressure still
   * drops Interactions deterministically (fail-open for the host).
   */
  pressure?: Partial<RecorderPressureLimits>;
}

export interface RecorderHandle {
  detach(): void;
  /** Best-effort drain of the background persist queue (tests/shutdown). */
  drain(timeoutMs?: number): Promise<void>;
  /** Pull snapshot of recorder health counters and pressure gauges. */
  stats(): RecorderStats;
  /**
   * Snapshot of pressure counters for harnesses.
   * @deprecated Use `stats()` instead.
   */
  pressureStats(): RecorderStats;
}

/**
 * Attach Epok recording to the current Node process:
 * inbound `http.Server` request context + outbound `fetch` interception,
 * with bounded async sanitize/finalize/persist and deterministic shedding.
 */
export function attachRecorder(options: AttachRecorderOptions): RecorderHandle {
  const runtime = createAttachRuntime(
    attachRuntimeOptions(options, (work) => {
      setImmediate(work);
    }),
  );

  const restoreInbound = installInboundAttach(runtime);

  let detached = false;
  return {
    detach(): void {
      if (detached) return;
      detached = true;
      restoreInbound();
      runtime.detach();
    },
    drain(timeoutMs = 5_000): Promise<void> {
      return runtime.drain(timeoutMs);
    },
    stats() {
      return runtime.stats();
    },
    pressureStats() {
      return runtime.stats();
    },
  };
}
