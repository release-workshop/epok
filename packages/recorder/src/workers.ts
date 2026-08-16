import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import { attachRuntimeOptions, createAttachRuntime } from "./attach-runtime.js";
import type { CaptureMode } from "./capture-mode.js";
import {
  captureFetchResponse,
  inboundSnapshotFromFetch,
  readFetchInboundBody,
} from "./workers-capture.js";
import { requestContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";
import type { RecorderPressureLimits } from "./pressure.js";
import type { RecorderStats } from "./stats.js";

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
  const runtimeIdentity = options.runtime ?? DEFAULT_WORKERS_RUNTIME;
  const runtime = createAttachRuntime(
    attachRuntimeOptions(options, (work) => {
      queueMicrotask(work);
    }),
  );

  function wrapHandler(handler: WorkersFetchHandler): WorkersFetchHandler {
    return async (request: Request): Promise<Response> => {
      const begun = runtime.begin();

      if (begun.kind === "disabled") {
        return requestContext.run(begun.ctx, () => handler(request));
      }

      if (begun.kind === "shed") {
        return requestContext.run(begun.ctx, async () => {
          runtime.observeInbound(begun.ctx, request);
          const response = await handler(request);
          runtime.observeResponse(begun.ctx, response);
          return response;
        });
      }

      const { ctx, buf } = begun;
      return requestContext.run(ctx, async () => {
        try {
          readFetchInboundBody(request, buf, runtime.pressure);
        } catch {
          // Fail-open.
        }

        runtime.observeInbound(ctx, request);

        const runSettle = (hostError: boolean): void => {
          runtime.trackSettle(
            runtime.settle({
              interactionId: ctx.interactionId,
              buf,
              inbound: inboundSnapshotFromFetch(request),
              terminalHostError: hostError,
              runtime: runtimeIdentity,
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

        runtime.observeResponse(ctx, response);

        const captured = captureFetchResponse(response, buf, runtime.pressure);
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
