import type { RecorderObservationHooks, StorageProvider } from "@epok/core";
import type { RecorderWideEvent } from "./events.js";
import { installInboundAttach } from "./inbound.js";
import { installFetchIntercept } from "./outbound.js";

export type { RecorderObservationHooks, StorageProvider };
export type { RecorderWideEvent } from "./events.js";
export { finalizeObservation } from "./finalize.js";
export type {
  FinalizedInteraction,
  FinalizeObservationOptions,
  ObservedCapture,
  ObservedDependency,
  ObservedHttpMessage,
  ObservedHttpRequest,
  ObservedHttpResponse,
} from "./finalize.js";

/**
 * Options for attaching the recorder to a Node HTTP server.
 * Node-only types stay in this package; observation uses Fetch-shaped hooks from `@epok/core`.
 */
export interface AttachRecorderOptions {
  storage: StorageProvider;
  hooks?: RecorderObservationHooks;
  /** Wide structured self-observation events (observed, drops, context failures). */
  onEvent?: (event: RecorderWideEvent) => void;
}

export interface RecorderHandle {
  detach(): void;
}

/**
 * Attach Epok observe-only recording to the current Node process:
 * inbound `http.Server` request context + outbound `fetch` interception.
 */
export function attachRecorder(options: AttachRecorderOptions): RecorderHandle {
  const emit = (event: RecorderWideEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Fail-open: subscriber errors must not affect the host.
    }
  };

  const restoreInbound = installInboundAttach(options.hooks, emit);
  const restoreFetch = installFetchIntercept(options.hooks, emit);

  let detached = false;
  return {
    detach(): void {
      if (detached) return;
      detached = true;
      restoreFetch();
      restoreInbound();
    },
  };
}
