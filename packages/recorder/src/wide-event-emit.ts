import type { RecorderWideEvent } from "./events.js";
import type { EmitWideEvent } from "./observe.js";

/**
 * Opt-in wide-event verbosity when `onEvent` is set.
 * - `"ops"`: queue/shed/drop/elide/finalize/persist/`observation_dropped`
 * - `"all"`: ops set plus per-request `observed` / `context_missing`
 */
export type OnEventCategory = "ops" | "all";

/** Default when `onEvent` is configured — ops signals, no observe chatter. */
export const DEFAULT_ON_EVENT_CATEGORY: OnEventCategory = "ops";

const OPS_EVENT_TYPES = new Set<RecorderWideEvent["type"]>([
  "queue_depth",
  "shedding",
  "interaction_dropped",
  "body_elided",
  "interaction_finalized",
  "interaction_persisted",
  "observation_dropped",
]);

function includesType(
  type: RecorderWideEvent["type"],
  category: OnEventCategory,
): boolean {
  if (category === "all") return true;
  return OPS_EVENT_TYPES.has(type);
}

/**
 * Build a fail-open emit function, or `undefined` when no subscriber is set
 * (skips wide-event construction/emission on the hot path).
 * Callers use `emit.includes(type)` to skip building filtered event payloads.
 */
export function createWideEventEmit(
  onEvent: ((event: RecorderWideEvent) => void) | undefined,
  category: OnEventCategory = DEFAULT_ON_EVENT_CATEGORY,
): EmitWideEvent | undefined {
  if (!onEvent) return undefined;

  const emit = ((event: RecorderWideEvent): void => {
    if (!includesType(event.type, category)) return;
    try {
      onEvent(event);
    } catch {
      // Fail-open: subscriber errors must not affect the host.
    }
  }) as EmitWideEvent;

  emit.includes = (type) => includesType(type, category);
  return emit;
}
