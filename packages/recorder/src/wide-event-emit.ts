import type { RecorderWideEvent } from "./events.js";
import type { EmitWideEvent } from "./observe.js";

/**
 * Build a fail-open emit function, or `undefined` when no subscriber is set
 * (skips wide-event construction/emission on the hot path).
 */
export function createWideEventEmit(
  onEvent: ((event: RecorderWideEvent) => void) | undefined,
): EmitWideEvent | undefined {
  if (!onEvent) return undefined;

  return (event: RecorderWideEvent): void => {
    try {
      onEvent(event);
    } catch {
      // Fail-open: subscriber errors must not affect the host.
    }
  };
}
