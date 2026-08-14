import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import { DEFAULT_CAPTURE_MODE, type CaptureMode } from "./capture-mode.js";
import {
  captureFetchResponse,
  inboundSnapshotFromFetch,
  readFetchInboundBody,
} from "./workers-capture.js";
import { createCaptureContext, requestContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";
import { installFetchIntercept } from "./outbound.js";
import { observeInbound, observeResponse } from "./observe.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
  type RecorderPressureLimits,
} from "./pressure.js";
import { BoundedAsyncQueue } from "./queue.js";
import { snapshotRecorderStats, type RecorderStats } from "./stats.js";
import { createSettleTracker, settleInteraction } from "./settle.js";
import { createWideEventEmit } from "./wide-event-emit.js";

export type { RecorderObservationHooks, StorageProvider };
export type { CaptureMode } from "./capture-mode.js";
export type { RecorderWideEvent } from "./events.js";
export type { RecorderPressureLimits } from "./pressure.js";
export type { RecorderStats } from "./stats.js";
export { startStatsExporter, statsCounterDeltas } from "./stats-exporter.js";
export type {
  StartStatsExporterOptions,
  StatsCounterDeltas,
  StatsExporterHandle,
  StatsExporterSample,
} from "./stats-exporter.js";

/** Fetch-shaped handler type for Cloudflare Workers and WinterCG runtimes. */
export type WorkersFetchHandler = (
  request: Request,
) => Response | Promise<Response>;

export interface AttachWorkersRecorderOptions {
  storage: StorageProvider;
  enabled?: boolean;
  captureMode?: CaptureMode;
  hooks?: RecorderObservationHooks;
  onEvent?: (event: RecorderWideEvent) => void;
  pressure?: Partial<RecorderPressureLimits>;
  /** Override runtime identity stamped on recorded Interactions. */
  runtime?: { name: string; version: string };
}

export interface WorkersRecorderHandle {
  /** Wrap an app fetch handler with Epok recording. */
  wrapHandler(handler: WorkersFetchHandler): WorkersFetchHandler;
  detach(): void;
  drain(timeoutMs?: number): Promise<void>;
  /** Pull snapshot of recorder health counters and pressure gauges. */
  stats(): RecorderStats;
  /**
   * Snapshot of pressure counters for harnesses.
   * @deprecated Use `stats()` instead.
   */
  pressureStats(): RecorderStats;
}

const DEFAULT_WORKERS_RUNTIME = {
  name: "cloudflare-workers",
  version: "workerd",
} as const;

/**
 * Attach Epok recording for Fetch-shaped runtimes (Cloudflare Workers first).
 * Installs outbound `fetch` interception and wraps the inbound fetch handler.
 * Requires `nodejs_als` (or Node) for AsyncLocalStorage request context.
 */
export function attachWorkersRecorder(
  options: AttachWorkersRecorderOptions,
): WorkersRecorderHandle {
  const enabled = options.enabled !== false;
  const captureMode = options.captureMode ?? DEFAULT_CAPTURE_MODE;
  const runtime = options.runtime ?? DEFAULT_WORKERS_RUNTIME;
  const emit = createWideEventEmit(options.onEvent);

  const limits: RecorderPressureLimits = {
    ...DEFAULT_PRESSURE_LIMITS,
    ...options.pressure,
  };
  const pressure = new PressureController(limits, emit);
  const queue = new BoundedAsyncQueue(pressure);
  const settles = createSettleTracker();

  const restoreFetch = installFetchIntercept(
    options.hooks,
    emit,
    pressure,
    enabled,
  );

  function wrapHandler(handler: WorkersFetchHandler): WorkersFetchHandler {
    return async (request: Request): Promise<Response> => {
      if (!enabled) {
        const ctx = createCaptureContext(false);
        return requestContext.run(ctx, () => handler(request));
      }

      pressure.recordObserved();
      const acquired = !pressure.sheddingActive && pressure.tryAcquireContext();
      const ctx = createCaptureContext(acquired);

      if (!acquired) {
        const reason = pressure.sheddingActive
          ? "queue_full"
          : "active_contexts_budget";
        pressure.recordDrop(reason, ctx.interactionId);
        return requestContext.run(ctx, async () => {
          observeInbound(ctx, request, options.hooks, emit);
          const response = await handler(request);
          observeResponse(ctx, response, options.hooks, emit);
          return response;
        });
      }

      return requestContext.run(ctx, async () => {
        const buf = ctx.capture;
        if (!buf) {
          return handler(request);
        }
        buf.interactionId = ctx.interactionId;

        try {
          readFetchInboundBody(request, buf, pressure);
        } catch {
          // Fail-open.
        }

        observeInbound(ctx, request, options.hooks, emit);

        const runSettle = (hostError: boolean): void => {
          settles.track(
            settleInteraction({
              interactionId: ctx.interactionId,
              buf,
              inbound: inboundSnapshotFromFetch(request),
              captureMode,
              emit,
              storage: options.storage,
              pressure,
              queue,
              deferOffHotPath: (work) => {
                queueMicrotask(work);
              },
              terminalHostError: hostError,
              runtime,
            }),
          );
        };

        let response: Response;
        try {
          response = await handler(request);
        } catch (err) {
          buf.terminalHostError = true;
          runSettle(true);
          throw err;
        }

        observeResponse(ctx, response, options.hooks, emit);

        const captured = captureFetchResponse(response, buf, pressure);
        runSettle(false);

        return captured;
      });
    };
  }

  let detached = false;
  return {
    wrapHandler,
    detach(): void {
      if (detached) return;
      detached = true;
      restoreFetch();
      queue.close();
    },
    drain(timeoutMs = 5_000): Promise<void> {
      return settles.drain(timeoutMs, queue);
    },
    stats() {
      return snapshotRecorderStats(pressure);
    },
    pressureStats() {
      return snapshotRecorderStats(pressure);
    },
  };
}
