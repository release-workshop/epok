import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import { DEFAULT_CAPTURE_MODE, type CaptureMode } from "./capture-mode.js";
import type { RecorderWideEvent } from "./events.js";
import { installInboundAttach } from "./inbound.js";
import { installFetchIntercept } from "./outbound.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
  type RecorderPressureLimits,
} from "./pressure.js";
import { BoundedAsyncQueue } from "./queue.js";
import { snapshotRecorderStats, type RecorderStats } from "./stats.js";
import {
  createWideEventEmit,
  DEFAULT_ON_EVENT_CATEGORIES,
  type OnEventCategories,
} from "./wide-event-emit.js";

export type { RecorderObservationHooks, StorageProvider };
export type { CaptureMode } from "./capture-mode.js";
export {
  DEFAULT_CAPTURE_MODE,
  shouldPersistInteraction,
} from "./capture-mode.js";
export type { RecorderWideEvent } from "./events.js";
export type { OnEventCategories } from "./wide-event-emit.js";
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
  /** Wide structured self-observation events (opt-in; advanced / harness path). */
  onEvent?: (event: RecorderWideEvent) => void;
  /**
   * Wide-event category filter when `onEvent` is set.
   * - `"pressure"` (default): queue/shed/drop/elide/finalize/persist/`observation_dropped`
   * - `"all"`: pressure set plus per-request `observed` and `context_missing`
   */
  onEventCategories?: OnEventCategories;
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
  const enabled = options.enabled !== false;
  const captureMode = options.captureMode ?? DEFAULT_CAPTURE_MODE;
  const emit = createWideEventEmit(
    options.onEvent,
    options.onEventCategories ?? DEFAULT_ON_EVENT_CATEGORIES,
  );

  const limits: RecorderPressureLimits = {
    ...DEFAULT_PRESSURE_LIMITS,
    ...options.pressure,
  };
  const pressure = new PressureController(limits, emit);
  const queue = new BoundedAsyncQueue(pressure);

  const restoreInbound = installInboundAttach({
    enabled,
    captureMode,
    hooks: options.hooks,
    emit,
    storage: options.storage,
    pressure,
    queue,
  });
  const restoreFetch = installFetchIntercept(
    options.hooks,
    emit,
    pressure,
    enabled,
  );

  let detached = false;
  return {
    detach(): void {
      if (detached) return;
      detached = true;
      restoreFetch();
      restoreInbound();
      queue.close();
    },
    drain(timeoutMs?: number): Promise<void> {
      return queue.drain(timeoutMs);
    },
    stats() {
      return snapshotRecorderStats(pressure);
    },
    pressureStats() {
      return snapshotRecorderStats(pressure);
    },
  };
}
