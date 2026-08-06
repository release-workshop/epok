/**
 * Wide structured self-observation events for recorder health (observe-only).
 * Fail-open: emitting these must never fail the host request path.
 */
export type RecorderWideEvent =
  | {
      type: "observed";
      phase: "inbound" | "dependency" | "response";
      interactionId: string;
      method: string;
      url: string;
      /** Lowercase header map for inbound/dependency requests. */
      requestHeaders?: Record<string, string>;
      status?: number;
    }
  | {
      type: "context_missing";
      phase: "dependency";
      reason: string;
      method: string;
      url: string;
    }
  | {
      type: "observation_dropped";
      reason: string;
      interactionId?: string;
      cause?: string;
    };
