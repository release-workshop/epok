/**
 * Timing modes. MVP implements `instant` only; `realtime` is reserved.
 */
export type ReplayTimingMode = "instant" | "realtime";

/**
 * Mismatch policy. MVP implements `strict` only; `diagnostic-lenient` is reserved.
 */
export type ReplayMismatchMode = "strict" | "diagnostic-lenient";

/**
 * First-class replay modes over the same Interaction artifact (RFC §3).
 * `executable` re-drives the app path; `snapshot` serves fixtures only.
 */
export type ReplayPlaybackMode = "executable" | "snapshot";

export interface ReplayMismatch {
  code: string;
  message: string;
  dependencySeq?: number;
  method?: string;
  url?: string;
}

export interface ReplayResult {
  ok: boolean;
  interactionId: string;
  message: string;
  timing?: ReplayTimingMode;
  mode?: ReplayMismatchMode;
  /** Which first-class replay mode produced this result. */
  playback?: ReplayPlaybackMode;
  mismatches?: ReplayMismatch[];
  /** Reserved for future realtime timing diagnostics. */
  timingNotes?: string[];
  /** Reserved for future signature regeneration outcomes (no secret material). */
  signatureOutcomes?: Array<{
    secretRef: string;
    ok: boolean;
    message?: string;
  }>;
}
