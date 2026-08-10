/**
 * Timing modes. `instant` (default) resolves as soon as matching succeeds;
 * `realtime` paces dependency completion from recorded timings (RFC §6).
 */
export type ReplayTimingMode = "instant" | "realtime";

/**
 * Mismatch policy. `strict` fail-fast (default); `diagnostic-lenient` continues
 * after safe soft mismatches for investigation and never claims deterministic
 * success when deviations occurred.
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
  /** Realtime pacing drift notes (best-effort; absent/empty for instant). */
  timingNotes?: string[];
  /** Signature regeneration outcomes (no secret material). Absent when unused. */
  signatureOutcomes?: Array<{
    secretRef: string;
    ok: boolean;
    message?: string;
  }>;
}
