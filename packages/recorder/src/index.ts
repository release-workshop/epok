import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import type { RecorderWideEvent } from "./events.js";
import { installInboundAttach } from "./inbound.js";
import { installFetchIntercept } from "./outbound.js";
import type { EmitWideEvent } from "./observe.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
  type RecorderPressureLimits,
} from "./pressure.js";
import { BoundedAsyncQueue } from "./queue.js";

export type { RecorderObservationHooks, StorageProvider };
export type { RecorderWideEvent } from "./events.js";
export type { RecorderPressureLimits } from "./pressure.js";
export { DEFAULT_PRESSURE_LIMITS } from "./pressure.js";
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
  hooks?: RecorderObservationHooks;
  /** Wide structured self-observation events (observed, drops, context failures). */
  onEvent?: (event: RecorderWideEvent) => void;
  /**
   * Upper bounds for async sanitize/finalize/persist work and capture buffers.
   * When exceeded, Interactions are dropped deterministically (fail-open for the host).
   */
  pressure?: Partial<RecorderPressureLimits>;
}

export interface RecorderHandle {
  detach(): void;
  /** Best-effort drain of the background persist queue (tests/shutdown). */
  drain(timeoutMs?: number): Promise<void>;
  /** Snapshot of pressure counters for harnesses. */
  pressureStats(): {
    observed: number;
    dropped: number;
    queueDepth: number;
    queueLimit: number;
    overBudget: boolean;
    sheddingActive: boolean;
    bufferedBytes: number;
    activeContexts: number;
  };
}

/**
 * Attach Epok recording to the current Node process:
 * inbound `http.Server` request context + outbound `fetch` interception,
 * with bounded async sanitize/finalize/persist and deterministic shedding.
 */
export function attachRecorder(options: AttachRecorderOptions): RecorderHandle {
  const enabled = options.enabled !== false;
  const emit: EmitWideEvent | undefined = options.onEvent
    ? (event: RecorderWideEvent): void => {
        try {
          options.onEvent?.(event);
        } catch {
          // Fail-open: subscriber errors must not affect the host.
        }
      }
    : undefined;

  const limits: RecorderPressureLimits = {
    ...DEFAULT_PRESSURE_LIMITS,
    ...options.pressure,
  };
  const pressure = new PressureController(limits, emit);
  const queue = new BoundedAsyncQueue(pressure);

  const restoreInbound = installInboundAttach({
    enabled,
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
    pressureStats() {
      return {
        observed: pressure.observed,
        dropped: pressure.dropped,
        queueDepth: pressure.queueDepth,
        queueLimit: pressure.limits.maxQueueDepth,
        overBudget: pressure.overBudget,
        sheddingActive: pressure.sheddingActive,
        bufferedBytes: pressure.bufferedBytes,
        activeContexts: pressure.activeContexts,
      };
    },
  };
}
