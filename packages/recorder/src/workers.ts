import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import type { CaptureMode } from "./capture-mode.js";
import {
  DEFAULT_CAPTURE_MODE,
  shouldPersistInteraction,
} from "./capture-mode.js";
import {
  buildObservedCaptureFromFetch,
  captureFetchResponse,
  readFetchInboundBody,
} from "./workers-capture.js";
import { createCaptureContext, requestContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";
import { finalizeObservation } from "./finalize.js";
import { installFetchIntercept } from "./outbound.js";
import type { EmitWideEvent } from "./observe.js";
import { observeInboundFetch, observeResponseFetch } from "./observe-fetch.js";
import { persistFinalizedInteraction } from "./persist.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
  type RecorderPressureLimits,
} from "./pressure.js";
import { BoundedAsyncQueue } from "./queue.js";
import { snapshotRecorderStats, type RecorderStats } from "./stats.js";
import {
  releaseCaptureBytes,
  waitForBodyReads,
  type CaptureBuffers,
} from "./capture.js";
import {
  createWideEventEmit,
  DEFAULT_ON_EVENT_CATEGORIES,
  type OnEventCategories,
} from "./wide-event-emit.js";

export type { RecorderObservationHooks, StorageProvider };
export type { CaptureMode } from "./capture-mode.js";
export type { RecorderWideEvent } from "./events.js";
export type { OnEventCategories } from "./wide-event-emit.js";
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
  /**
   * Wide-event category filter when `onEvent` is set.
   * Defaults to `"pressure"` (no per-request `observed` / `context_missing`).
   */
  onEventCategories?: OnEventCategories;
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
  const pendingSettles = new Set<Promise<void>>();

  function trackSettle(promise: Promise<void>): void {
    pendingSettles.add(promise);
    void promise.finally(() => {
      pendingSettles.delete(promise);
    });
  }

  async function drainAll(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pendingSettles.size === 0 && queue.depth === 0) {
        return;
      }
      await Promise.allSettled([...pendingSettles]);
      await queue.drain(Math.max(0, deadline - Date.now()));
      if (pendingSettles.size === 0 && queue.depth === 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

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
          observeInboundFetch(ctx, request, options.hooks, emit);
          const response = await handler(request);
          observeResponseFetch(ctx, request, response, options.hooks, emit);
          return response;
        });
      }

      return requestContext.run(ctx, async () => {
        const buf = ctx.capture;
        if (!buf) {
          return handler(request);
        }
        buf.interactionId = ctx.interactionId;

        let terminalHostError = false;
        try {
          readFetchInboundBody(request, buf, pressure);
        } catch {
          // Fail-open.
        }

        observeInboundFetch(ctx, request, options.hooks, emit);

        let response: Response;
        try {
          response = await handler(request);
        } catch (err) {
          terminalHostError = true;
          buf.terminalHostError = true;
          trackSettle(
            settleWorkersInteraction({
              interactionId: ctx.interactionId,
              request,
              response: null,
              buf,
              captureMode,
              emit,
              storage: options.storage,
              pressure,
              queue,
              runtime,
              terminalHostError,
            }),
          );
          throw err;
        }

        observeResponseFetch(ctx, request, response, options.hooks, emit);

        const captured = captureFetchResponse(response, buf, pressure);
        trackSettle(
          settleWorkersInteraction({
            interactionId: ctx.interactionId,
            request,
            response: captured,
            buf,
            captureMode,
            emit,
            storage: options.storage,
            pressure,
            queue,
            runtime,
            terminalHostError,
          }),
        );

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
    drain(timeoutMs?: number): Promise<void> {
      return drainAll(timeoutMs);
    },
    stats() {
      return snapshotRecorderStats(pressure);
    },
    pressureStats() {
      return snapshotRecorderStats(pressure);
    },
  };
}

async function settleWorkersInteraction(input: {
  interactionId: string;
  request: Request;
  response: Response | null;
  buf: CaptureBuffers;
  captureMode: CaptureMode;
  emit: EmitWideEvent | undefined;
  storage: StorageProvider;
  pressure: PressureController;
  queue: BoundedAsyncQueue;
  runtime: { name: string; version: string };
  terminalHostError: boolean;
}): Promise<void> {
  const {
    interactionId,
    request,
    response,
    buf,
    captureMode,
    emit,
    storage,
    pressure,
    queue,
    runtime,
    terminalHostError,
  } = input;

  try {
    await waitForBodyReads(buf);

    if (buf.dropped) {
      if (buf.dropReason === "buffered_bytes_budget") {
        pressure.recordDrop("buffered_bytes_budget", interactionId);
      }
      releaseCaptureBytes(pressure, buf);
      pressure.releaseContext();
      return;
    }

    if (terminalHostError) {
      buf.terminalHostError = true;
    }

    const status = response?.status ?? buf.statusCode;
    if (
      !shouldPersistInteraction(captureMode, {
        status,
        terminalHostError: buf.terminalHostError,
      })
    ) {
      scheduleCaptureModeDrop({
        interactionId,
        reservedBytes: buf.reservedBytes,
        emit,
        pressure,
      });
      buf.reservedBytes = 0;
      return;
    }

    const reservedForJob = buf.reservedBytes;
    buf.reservedBytes = 0;

    const enqueued = queue.tryEnqueue(async () => {
      try {
        const capture = buildObservedCaptureFromFetch(
          interactionId,
          request,
          response,
          buf,
          captureMode,
          runtime,
        );
        const finalized = finalizeObservation(capture, {
          ...(emit ? { onEvent: emit } : {}),
          onFinalized: () => {
            pressure.recordFinalized();
          },
        });
        if (finalized === null) {
          return;
        }
        await persistFinalizedInteraction(storage, finalized, emit, () => {
          pressure.recordPersisted();
        });
      } finally {
        pressure.releaseBytes(reservedForJob);
        pressure.releaseContext();
      }
    });

    if (!enqueued) {
      pressure.releaseBytes(reservedForJob);
      pressure.releaseContext();
      pressure.recordDrop("queue_full", interactionId);
    }
  } catch {
    try {
      releaseCaptureBytes(pressure, buf);
      pressure.releaseContext();
    } catch {
      // Fail-open.
    }
  }
}

function scheduleCaptureModeDrop(input: {
  interactionId: string;
  reservedBytes: number;
  emit: EmitWideEvent | undefined;
  pressure: PressureController;
}): void {
  const { interactionId, reservedBytes, emit, pressure } = input;
  queueMicrotask(() => {
    try {
      pressure.recordFiltered();
      emit?.({
        type: "interaction_dropped",
        reason: "capture_mode_filter",
        interactionId,
      });
    } finally {
      pressure.releaseBytes(reservedBytes);
      pressure.releaseContext();
    }
  });
}
