/**
 * Wide structured self-observation events for recorder health.
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
    }
  | {
      type: "interaction_finalized";
      interactionId: string;
      manifestHash: string;
    }
  | {
      type: "interaction_persisted";
      interactionId: string;
      manifestHash: string;
    }
  | {
      type: "interaction_dropped";
      reason: string;
      interactionId: string;
      cause?: string;
    }
  | {
      type: "queue_depth";
      depth: number;
      limit: number;
    }
  | {
      type: "shedding";
      active: boolean;
      reason?: string;
      /** Running totals for dropped/observed ratio. */
      observed: number;
      dropped: number;
    }
  | {
      type: "body_elided";
      reason: "buffered_bytes_budget";
      /** Bytes released from this capture when already-buffered bodies were dropped. */
      releasedBytes: number;
    };
