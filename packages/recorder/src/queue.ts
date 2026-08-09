import type { PressureController } from "./pressure.js";

export type QueueJob = () => Promise<void>;

/**
 * Bounded async queue for sanitize/finalize/persist work.
 * When full, `tryEnqueue` returns false so the caller can shed deterministically.
 * Drain never blocks the host request path.
 */
export class BoundedAsyncQueue {
  private readonly pressure: PressureController;
  private readonly pending: QueueJob[] = [];
  private running = 0;
  private closed = false;

  constructor(pressure: PressureController) {
    this.pressure = pressure;
  }

  get depth(): number {
    return this.pending.length + this.running;
  }

  get limit(): number {
    return this.pressure.limits.maxQueueDepth;
  }

  /**
   * Enqueue background work. Returns false when at capacity (caller must drop).
   * Fail-open: job errors are swallowed after the job rejects.
   */
  tryEnqueue(job: QueueJob): boolean {
    if (this.closed) return false;
    if (this.depth >= this.limit) {
      return false;
    }
    this.pending.push(job);
    this.pressure.setQueueDepth(this.depth);
    this.pump();
    return true;
  }

  /** Best-effort drain for tests/shutdown. Does not await in-flight forever. */
  async drain(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.depth > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.pressure.setQueueDepth(this.running);
  }

  private pump(): void {
    const max = this.pressure.limits.maxConcurrency;
    while (this.running < max && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.running += 1;
      this.pressure.setQueueDepth(this.depth);
      // setImmediate yields to the HTTP poll phase so finalize/persist does not
      // starve inbound request handling under load (credibility B bar).
      void new Promise<void>((resolve) => {
        setImmediate(resolve);
      })
        .then(() => job())
        .catch(() => {
          // Fail-open: background failures never reach the host.
        })
        .finally(() => {
          this.running -= 1;
          this.pressure.setQueueDepth(this.depth);
          this.pump();
        });
    }
  }
}
