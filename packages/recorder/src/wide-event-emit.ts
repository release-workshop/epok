import type { RecorderWideEvent } from "./events.js";
import type { EmitWideEvent } from "./observe.js";

/** Opt-in wide-event verbosity when `onEvent` is set. Locked by issue 33. */
export type OnEventCategories = "pressure" | "all";

/** Default when `onEvent` is configured — shed/queue/lifecycle, no observe chatter. */
export const DEFAULT_ON_EVENT_CATEGORIES: OnEventCategories = "pressure";

const PRESSURE_EVENT_TYPES = new Set<RecorderWideEvent["type"]>([
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
  categories: OnEventCategories,
): boolean {
  if (categories === "all") return true;
  return PRESSURE_EVENT_TYPES.has(type);
}

/**
 * Build a fail-open emit function, or `undefined` when no subscriber is set
 * (skips wide-event construction/emission on the hot path).
 * Callers use `emit.includes(type)` to skip building filtered event payloads.
 */
export function createWideEventEmit(
  onEvent: ((event: RecorderWideEvent) => void) | undefined,
  categories: OnEventCategories = DEFAULT_ON_EVENT_CATEGORIES,
): EmitWideEvent | undefined {
  if (!onEvent) return undefined;

  const emit = ((event: RecorderWideEvent): void => {
    if (!includesType(event.type, categories)) return;
    try {
      onEvent(event);
    } catch {
      // Fail-open: subscriber errors must not affect the host.
    }
  }) as EmitWideEvent;

  emit.includes = (type) => includesType(type, categories);
  return emit;
}
