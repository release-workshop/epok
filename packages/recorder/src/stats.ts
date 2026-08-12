import type { PressureController } from "./pressure.js";

/** Pull snapshot of recorder health counters and pressure gauges (since attach). */
export interface RecorderStats {
  /** Inbound Interaction attempts (includes shed-at-entry). */
  observed: number;
  /** Successful sanitize/finalize completions. */
  finalized: number;
  /** Successful Storage Provider writes after finalize. */
  persisted: number;
  /** Pressure sheds only (`queue_full`, `active_contexts_budget`, `buffered_bytes_budget`). */
  dropped: number;
  /** Capture-mode skips (`capture_mode_filter`); not counted in `dropped`. */
  filtered: number;
  /** Body-elision activations. */
  elided: number;
  queueDepth: number;
  queueLimit: number;
  activeContexts: number;
  bufferedBytes: number;
  overBudget: boolean;
  sheddingActive: boolean;
  byteBudgetExhausted: boolean;
}

/** Build a read-only stats snapshot from the pressure controller (off hot path). */
export function snapshotRecorderStats(
  pressure: PressureController,
): RecorderStats {
  return {
    observed: pressure.observed,
    finalized: pressure.finalized,
    persisted: pressure.persisted,
    dropped: pressure.dropped,
    filtered: pressure.filtered,
    elided: pressure.elided,
    queueDepth: pressure.queueDepth,
    queueLimit: pressure.limits.maxQueueDepth,
    activeContexts: pressure.activeContexts,
    bufferedBytes: pressure.bufferedBytes,
    overBudget: pressure.overBudget,
    sheddingActive: pressure.sheddingActive,
    byteBudgetExhausted: pressure.byteBudgetExhausted,
  };
}
