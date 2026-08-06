import type { RecorderObservationHooks } from "@epok/core";
import { requestContext } from "./context.js";
import type { EmitWideEvent } from "./observe.js";
import { observeDependency } from "./observe.js";

/**
 * Wrap `globalThis.fetch` so outbound calls are associated with the current
 * request context. Always fail-open: observation errors never reject fetch.
 */
export function installFetchIntercept(
  hooks: RecorderObservationHooks | undefined,
  emit: EmitWideEvent,
): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const ctx = requestContext.getStore();
    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      observeDependency(ctx, input, init, null, hooks, emit);
      throw err;
    }
    observeDependency(ctx, input, init, response, hooks, emit);
    return response;
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}
