import type {
  RecorderObservationHooks,
  RuntimeIdentity,
  StorageProvider,
} from "@epok/core";
import { DEFAULT_CAPTURE_MODE, type CaptureMode } from "./capture-mode.js";
import type { CaptureBuffers, InboundSnapshot } from "./capture.js";
import { createCaptureContext, type RequestCaptureContext } from "./context.js";
import type { RecorderWideEvent } from "./events.js";
import { observeInbound, observeResponse } from "./observe.js";
import { installFetchIntercept } from "./outbound.js";
import {
  DEFAULT_PRESSURE_LIMITS,
  PressureController,
  type PressureDropReason,
  type RecorderPressureLimits,
} from "./pressure.js";
import { BoundedAsyncQueue } from "./queue.js";
import {
  createSettleTracker,
  settleInteraction,
  type DeferOffHotPath,
} from "./settle.js";
import { snapshotRecorderStats, type RecorderStats } from "./stats.js";
import { createWideEventEmit } from "./wide-event-emit.js";

/** Schedule background work off the host request path. */
export type DeferJob = DeferOffHotPath;

export interface AttachRuntimeOptions {
  storage: StorageProvider;
  enabled?: boolean;
  captureMode?: CaptureMode;
  hooks?: RecorderObservationHooks;
  onEvent?: (event: RecorderWideEvent) => void;
  pressure?: Partial<RecorderPressureLimits>;
  /** Node: setImmediate. Fetch: queueMicrotask. */
  deferJob: DeferJob;
}

/** Public attach options without the runtime-owned scheduler. */
export type AttachRuntimePublicOptions = Omit<AttachRuntimeOptions, "deferJob">;

/**
 * Build AttachRuntimeOptions under exactOptionalPropertyTypes
 * (omit keys when the public option is undefined).
 */
export function attachRuntimeOptions(
  options: AttachRuntimePublicOptions,
  deferJob: DeferJob,
): AttachRuntimeOptions {
  return {
    storage: options.storage,
    deferJob,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.captureMode !== undefined
      ? { captureMode: options.captureMode }
      : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    ...(options.pressure !== undefined ? { pressure: options.pressure } : {}),
  };
}

export type BeginResult =
  | { kind: "disabled"; ctx: RequestCaptureContext }
  | {
      kind: "shed";
      ctx: RequestCaptureContext;
      reason: Extract<
        PressureDropReason,
        "queue_full" | "active_contexts_budget"
      >;
    }
  | { kind: "capture"; ctx: RequestCaptureContext; buf: CaptureBuffers };

/** Interaction-local facts for settle; collaborators live on the runtime. */
export interface SettleFromRuntimeInput {
  interactionId: string;
  buf: CaptureBuffers;
  inbound: InboundSnapshot;
  terminalHostError?: boolean;
  refreshTerminal?: () => void;
  runtime?: RuntimeIdentity;
}

export interface AttachRuntime {
  /** Adapter-facing pressure for body-capture helpers (not a public package export). */
  readonly pressure: PressureController;
  begin(): BeginResult;
  observeInbound(ctx: RequestCaptureContext, request: Request): void;
  observeResponse(ctx: RequestCaptureContext, response: Response): void;
  settle(input: SettleFromRuntimeInput): Promise<void>;
  trackSettle(promise: Promise<void>): void;
  drain(timeoutMs?: number): Promise<void>;
  stats(): RecorderStats;
  detach(): void;
}

function beginInteraction(
  enabled: boolean,
  pressure: PressureController,
): BeginResult {
  if (!enabled) {
    return { kind: "disabled", ctx: createCaptureContext(false) };
  }

  pressure.recordObserved();
  const acquired = !pressure.sheddingActive && pressure.tryAcquireContext();
  const ctx = createCaptureContext(acquired);

  if (!acquired) {
    const reason = pressure.sheddingActive
      ? "queue_full"
      : "active_contexts_budget";
    pressure.recordDrop(reason, ctx.interactionId);
    return { kind: "shed", ctx, reason };
  }

  // Acquired contexts always allocate CaptureBuffers.
  const buf = ctx.capture as CaptureBuffers;
  buf.interactionId = ctx.interactionId;
  return { kind: "capture", ctx, buf };
}

function settleFromRuntime(
  options: {
    storage: StorageProvider;
    captureMode: CaptureMode;
    emit: ReturnType<typeof createWideEventEmit>;
    pressure: PressureController;
    queue: BoundedAsyncQueue;
    deferJob: DeferJob;
  },
  input: SettleFromRuntimeInput,
): Promise<void> {
  return settleInteraction({
    interactionId: input.interactionId,
    buf: input.buf,
    inbound: input.inbound,
    captureMode: options.captureMode,
    emit: options.emit,
    storage: options.storage,
    pressure: options.pressure,
    queue: options.queue,
    deferOffHotPath: options.deferJob,
    ...(input.terminalHostError !== undefined
      ? { terminalHostError: input.terminalHostError }
      : {}),
    ...(input.refreshTerminal !== undefined
      ? { refreshTerminal: input.refreshTerminal }
      : {}),
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
  });
}

/**
 * Shared recorder attach runtime: pressure, queue, outbound fetch, begin gate,
 * bound Observation helpers, and narrow settle. Inbound adapters call in (push).
 */
export function createAttachRuntime(
  options: AttachRuntimeOptions,
): AttachRuntime {
  const enabled = options.enabled !== false;
  const captureMode = options.captureMode ?? DEFAULT_CAPTURE_MODE;
  const hooks = options.hooks;
  const emit = createWideEventEmit(options.onEvent);
  const deferJob = options.deferJob;

  const limits: RecorderPressureLimits = {
    ...DEFAULT_PRESSURE_LIMITS,
    ...options.pressure,
  };
  const pressure = new PressureController(limits, emit);
  const queue = new BoundedAsyncQueue(pressure, deferJob);
  const settles = createSettleTracker();
  const restoreFetch = installFetchIntercept(hooks, emit, pressure, enabled);

  let detached = false;
  const settleOptions = {
    storage: options.storage,
    captureMode,
    emit,
    pressure,
    queue,
    deferJob,
  };

  return {
    pressure,
    begin: () => beginInteraction(enabled, pressure),
    observeInbound(ctx, request) {
      observeInbound(ctx, request, hooks, emit);
    },
    observeResponse(ctx, response) {
      observeResponse(ctx, response, hooks, emit);
    },
    settle(input) {
      return settleFromRuntime(settleOptions, input);
    },
    trackSettle(promise) {
      settles.track(promise);
    },
    drain(timeoutMs = 5_000) {
      return settles.drain(timeoutMs, queue);
    },
    stats() {
      return snapshotRecorderStats(pressure);
    },
    detach() {
      if (detached) return;
      detached = true;
      restoreFetch();
      queue.close();
    },
  };
}
