/**
 * Capture-intensity persist mode (issue 40/41).
 * Collect stays always-on; this dial gates sanitize → finalize → persist only.
 */
export type CaptureMode = "full" | "errors";

/** Production default: lean storage — persist only real host errors. */
export const DEFAULT_CAPTURE_MODE: CaptureMode = "errors";

/**
 * Whether sanitize/finalize/persist should run for a completed Interaction.
 * `errors` keeps only inbound status >= 500 or a terminal host exception.
 */
export function shouldPersistInteraction(
  mode: CaptureMode,
  opts: { status?: number; terminalHostError: boolean },
): boolean {
  if (mode === "full") return true;
  if (opts.terminalHostError) return true;
  if (opts.status === undefined) return false;
  return opts.status >= 500;
}
