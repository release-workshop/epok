/**
 * Wide structured self-observation events for recorder health.
 * Fail-open: emitting these must never fail the host request path.
 * HTTP inbound/dependency/response facts go to RecorderObservationHooks, not here.
 */
export type RecorderWideEvent =
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
      interactionId?: string;
    };
