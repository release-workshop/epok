import type { EmitWideEvent } from "./observe.js";

/** Configurable upper bounds for recorder background work and capture buffers. */
export interface RecorderPressureLimits {
  /** Max pending sanitize/finalize/persist jobs. */
  maxQueueDepth: number;
  /** Max concurrent background workers draining the queue. */
  maxConcurrency: number;
  /** Max in-flight Interaction capture contexts. */
  maxActiveContexts: number;
  /** Max buffered body bytes across active captures + pending queue jobs. */
  maxBufferedBytes: number;
  /**
   * When true (default), byte-budget pressure elides captured bodies and still
   * persists the Interaction. When false, the Interaction is dropped
   * (`buffered_bytes_budget`) as in the original shed path.
   */
  bodyElision: boolean;
}

export const DEFAULT_PRESSURE_LIMITS: RecorderPressureLimits = {
  maxQueueDepth: 128,
  maxConcurrency: 2,
  maxActiveContexts: 256,
  maxBufferedBytes: 16 * 1024 * 1024,
  bodyElision: true,
};

export type PressureDropReason =
  "queue_full" | "active_contexts_budget" | "buffered_bytes_budget";

/**
 * Tracks over-budget state, shed activation, and observed/dropped counters.
 * Application path stays fail-open: callers must never throw into the host.
 */
export class PressureController {
  readonly limits: RecorderPressureLimits;
  private readonly emit: EmitWideEvent | undefined;

  private _observed = 0;
  private _dropped = 0;
  private _activeContexts = 0;
  private _bufferedBytes = 0;
  private _queueDepth = 0;
  private _sheddingActive = false;
  private _lastDropAt = 0;
  private shedClearTimer: ReturnType<typeof setTimeout> | undefined;

  /** Stay in shed mode at least this long after the last drop. */
  private static readonly SHED_QUIET_MS = 500;

  constructor(limits: RecorderPressureLimits, emit: EmitWideEvent | undefined) {
    this.limits = limits;
    this.emit = emit;
  }

  get observed(): number {
    return this._observed;
  }

  get dropped(): number {
    return this._dropped;
  }

  get activeContexts(): number {
    return this._activeContexts;
  }

  get bufferedBytes(): number {
    return this._bufferedBytes;
  }

  get queueDepth(): number {
    return this._queueDepth;
  }

  get sheddingActive(): boolean {
    return this._sheddingActive;
  }

  /** True while any configured budget is exhausted. */
  get overBudget(): boolean {
    return (
      this._queueDepth >= this.limits.maxQueueDepth ||
      this._activeContexts >= this.limits.maxActiveContexts ||
      this._bufferedBytes >= this.limits.maxBufferedBytes ||
      this._sheddingActive
    );
  }

  recordObserved(): void {
    this._observed += 1;
  }

  tryAcquireContext(): boolean {
    if (this._activeContexts >= this.limits.maxActiveContexts) {
      return false;
    }
    this._activeContexts += 1;
    return true;
  }

  releaseContext(): void {
    if (this._activeContexts > 0) {
      this._activeContexts -= 1;
    }
    this.maybeDeactivateShedding();
  }

  tryReserveBytes(bytes: number): boolean {
    if (bytes <= 0) return true;
    if (this._bufferedBytes + bytes > this.limits.maxBufferedBytes) {
      return false;
    }
    this._bufferedBytes += bytes;
    return true;
  }

  releaseBytes(bytes: number): void {
    if (bytes <= 0) return;
    this._bufferedBytes = Math.max(0, this._bufferedBytes - bytes);
    this.maybeDeactivateShedding();
  }

  setQueueDepth(depth: number): void {
    const prev = this._queueDepth;
    this._queueDepth = depth;
    if (prev !== depth) {
      this.emit?.({
        type: "queue_depth",
        depth,
        limit: this.limits.maxQueueDepth,
      });
    }
    if (depth >= this.limits.maxQueueDepth) {
      this.activateShedding("queue_full");
    } else {
      this.maybeDeactivateShedding();
    }
  }

  /** True when reserving `bytes` would exceed the buffered-bytes budget. */
  wouldExceedByteBudget(bytes: number): boolean {
    if (bytes <= 0) return false;
    return this._bufferedBytes + bytes > this.limits.maxBufferedBytes;
  }

  /** True when new body capture should be skipped to stay under the byte budget. */
  get shouldElideBodies(): boolean {
    return (
      this.limits.bodyElision &&
      this._bufferedBytes >= this.limits.maxBufferedBytes
    );
  }

  recordBodyElision(releasedBytes: number): void {
    this.emit?.({
      type: "body_elided",
      reason: "buffered_bytes_budget",
      releasedBytes,
    });
  }

  recordDrop(reason: PressureDropReason, interactionId: string): void {
    this._dropped += 1;
    this._lastDropAt = Date.now();
    this.activateShedding(reason);
    this.emit?.({
      type: "interaction_dropped",
      reason,
      interactionId,
    });
  }

  private activateShedding(reason: string): void {
    const wasActive = this._sheddingActive;
    this._sheddingActive = true;
    if (this.shedClearTimer !== undefined) {
      clearTimeout(this.shedClearTimer);
      this.shedClearTimer = undefined;
    }
    if (!wasActive) {
      this.emit?.({
        type: "shedding",
        active: true,
        reason,
        observed: this._observed,
        dropped: this._dropped,
      });
    }
  }

  private maybeDeactivateShedding(): void {
    if (!this._sheddingActive) return;
    // Stay in over-budget mode until background work drains and drops stop,
    // so overload windows are stable (not flapping on each job completion).
    if (this._queueDepth > 0 || this._activeContexts > 0) return;
    if (this._bufferedBytes >= this.limits.maxBufferedBytes) return;
    const remaining =
      PressureController.SHED_QUIET_MS - (Date.now() - this._lastDropAt);
    if (remaining > 0) {
      if (this.shedClearTimer === undefined) {
        this.shedClearTimer = setTimeout(() => {
          this.shedClearTimer = undefined;
          this.maybeDeactivateShedding();
        }, remaining + 1);
      }
      return;
    }
    this._sheddingActive = false;
    this.emit?.({
      type: "shedding",
      active: false,
      observed: this._observed,
      dropped: this._dropped,
    });
  }
}
