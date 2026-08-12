import type { RecorderStats } from "./stats.js";

/** Monotonic counter deltas between two `stats()` snapshots. */
export interface StatsCounterDeltas {
  observed: number;
  finalized: number;
  persisted: number;
  dropped: number;
  filtered: number;
  elided: number;
}

/** One exporter sample: absolute snapshot + counter deltas since the previous sample. */
export interface StatsExporterSample {
  /** Wall-clock ms when the sample was taken (`Date.now()`). */
  at: number;
  snapshot: RecorderStats;
  /** Counter deltas since the previous sample; zeroed on the first sample. */
  deltas: StatsCounterDeltas;
}

export interface StartStatsExporterOptions {
  /**
   * Pull a `stats()` snapshot — typically `() => handle.stats()`.
   * Called only from the exporter timer / initial emit (never on the host request path).
   */
  stats: () => RecorderStats;
  /**
   * Receives each sample off the hot path. Throw failures are swallowed (fail-open).
   * Callers push to logs, metrics sinks, or dashboards as they choose.
   */
  onSample: (sample: StatsExporterSample) => void;
  /** Poll interval in milliseconds. Defaults to `10_000`. */
  intervalMs?: number;
  /**
   * When `true` (default), emit one sample immediately on start (deltas zeroed).
   * Set `false` to wait for the first interval tick; the baseline still starts now
   * so the first tick reports deltas since `startStatsExporter`.
   */
  emitInitial?: boolean;
}

export interface StatsExporterHandle {
  /** Stop polling. Idempotent. */
  stop(): void;
}

/** Subtract monotonic lifecycle counters (`next - prev`). */
export function statsCounterDeltas(
  prev: RecorderStats,
  next: RecorderStats,
): StatsCounterDeltas {
  return {
    observed: next.observed - prev.observed,
    finalized: next.finalized - prev.finalized,
    persisted: next.persisted - prev.persisted,
    dropped: next.dropped - prev.dropped,
    filtered: next.filtered - prev.filtered,
    elided: next.elided - prev.elided,
  };
}

const ZERO_DELTAS: StatsCounterDeltas = {
  observed: 0,
  finalized: 0,
  persisted: 0,
  dropped: 0,
  filtered: 0,
  elided: 0,
};

/**
 * Opt-in periodic exporter that polls `stats()` and emits absolute snapshots
 * plus counter deltas. No Prometheus/OTel dependency; no `onEvent` required.
 * Runs on a timer off the host request path.
 */
export function startStatsExporter(
  options: StartStatsExporterOptions,
): StatsExporterHandle {
  const intervalMs = options.intervalMs ?? 10_000;
  const emitInitial = options.emitInitial !== false;

  let previous = options.stats();
  let stopped = false;

  const emit = (snapshot: RecorderStats, deltas: StatsCounterDeltas): void => {
    try {
      options.onSample({
        at: Date.now(),
        snapshot,
        deltas,
      });
    } catch {
      // Fail-open: sink errors must not affect the host or stop polling.
    }
  };

  if (emitInitial) {
    emit(previous, { ...ZERO_DELTAS });
  }

  const timer = setInterval(() => {
    if (stopped) return;
    const snapshot = options.stats();
    const deltas = statsCounterDeltas(previous, snapshot);
    previous = snapshot;
    emit(snapshot, deltas);
  }, intervalMs);

  // Unref so the exporter alone does not keep a Node process alive.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
