import { type StorageProvider } from "@epok/core";
import { installDependencyInjection, type FetchInjection } from "./inject.js";
import { unsupportedSpecVersionMessage } from "./compat.js";
import { buildInboundRequest, loadManifest, resolveCasBytes } from "./load.js";
import type {
  ReplayMismatch,
  ReplayMismatchMode,
  ReplayPlaybackMode,
  ReplayResult,
  ReplayTimingMode,
} from "./types.js";

export type ReplayHandler = (request: Request) => Response | Promise<Response>;

export interface ReplayRunOptions {
  storage: StorageProvider;
  interactionId: string;
  /** Application entry re-driven with the recorded inbound Request. */
  handler: ReplayHandler;
  timing?: ReplayTimingMode;
  mode?: ReplayMismatchMode;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const EXECUTABLE: ReplayPlaybackMode = "executable";

/** Per-mode mismatch reporting policy (one place for strict vs lenient). */
const mismatchPolicy = {
  strict: {
    collectAllResponseMismatches: false,
    failureMessage(mismatches: readonly ReplayMismatch[]): string {
      return mismatches[0]?.message ?? "replay mismatch";
    },
    reportMismatches(mismatches: readonly ReplayMismatch[]): ReplayMismatch[] {
      const first = mismatches[0];
      return first === undefined ? [] : [first];
    },
  },
  "diagnostic-lenient": {
    collectAllResponseMismatches: true,
    failureMessage(mismatches: readonly ReplayMismatch[]): string {
      return `diagnostic-lenient replay found ${mismatches.length} mismatch(es)`;
    },
    reportMismatches(mismatches: readonly ReplayMismatch[]): ReplayMismatch[] {
      return [...mismatches];
    },
  },
} as const satisfies Record<
  ReplayMismatchMode,
  {
    collectAllResponseMismatches: boolean;
    failureMessage: (mismatches: readonly ReplayMismatch[]) => string;
    reportMismatches: (
      mismatches: readonly ReplayMismatch[],
    ) => ReplayMismatch[];
  }
>;

function failure(
  interactionId: string,
  message: string,
  options: {
    timing: ReplayTimingMode;
    mode: ReplayMismatchMode;
    mismatches?: ReplayMismatch[];
  },
): ReplayResult {
  const result: ReplayResult = {
    ok: false,
    interactionId,
    message,
    timing: options.timing,
    mode: options.mode,
    playback: EXECUTABLE,
  };
  if (options.mismatches !== undefined) {
    result.mismatches = options.mismatches;
  }
  return result;
}

function withTimingNotes(
  result: ReplayResult,
  timingNotes: string[],
): ReplayResult {
  if (timingNotes.length === 0) return result;
  return { ...result, timingNotes };
}

function firstMismatchMessage(
  mismatches: readonly ReplayMismatch[],
  fallback: string,
): string {
  return mismatches[0]?.message ?? fallback;
}

function handlerFailure(
  err: unknown,
  injection: FetchInjection,
  ctx: {
    manifestId: string;
    timing: ReplayTimingMode;
    mode: ReplayMismatchMode;
  },
): ReplayResult {
  const mismatches = injection.takeMismatches();
  const timingNotes = injection.takeTimingNotes();
  const errMessage =
    err instanceof Error ? err.message : "handler threw during replay";

  if (injection.hadHardMismatch() && mismatches.length > 0) {
    return withTimingNotes(
      failure(ctx.manifestId, firstMismatchMessage(mismatches, errMessage), {
        timing: ctx.timing,
        mode: ctx.mode,
        mismatches,
      }),
      timingNotes,
    );
  }

  if (mismatches.length > 0) {
    return withTimingNotes(
      failure(ctx.manifestId, errMessage, {
        timing: ctx.timing,
        mode: ctx.mode,
        mismatches: [
          ...mismatches,
          { code: "handler_error", message: errMessage },
        ],
      }),
      timingNotes,
    );
  }

  return withTimingNotes(
    failure(ctx.manifestId, errMessage, {
      timing: ctx.timing,
      mode: ctx.mode,
    }),
    timingNotes,
  );
}

async function compareToRecorded(
  storage: StorageProvider,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  response: Response,
  ctx: {
    timing: ReplayTimingMode;
    mode: ReplayMismatchMode;
    priorMismatches: ReplayMismatch[];
  },
): Promise<ReplayResult> {
  const policy = mismatchPolicy[ctx.mode];
  const actualBody = new Uint8Array(await response.arrayBuffer());
  const expectedBody = await resolveCasBytes(
    storage,
    manifest,
    manifest.response.body.cas,
  );

  const responseMismatches: ReplayMismatch[] = [];

  if (response.status !== manifest.response.status) {
    const statusMismatch: ReplayMismatch = {
      code: "response_status_mismatch",
      message: `response status ${response.status} !== recorded ${manifest.response.status}`,
    };
    if (!policy.collectAllResponseMismatches) {
      return failure(manifest.id, statusMismatch.message, {
        timing: ctx.timing,
        mode: ctx.mode,
        mismatches: [statusMismatch],
      });
    }
    responseMismatches.push(statusMismatch);
  }

  if (!bytesEqual(actualBody, expectedBody)) {
    responseMismatches.push({
      code: "response_body_mismatch",
      message: "response body does not match recorded Interaction",
    });
  }

  const mismatches = [...ctx.priorMismatches, ...responseMismatches];
  if (mismatches.length === 0) {
    return {
      ok: true,
      interactionId: manifest.id,
      message: "replay matched recorded Interaction",
      timing: ctx.timing,
      mode: ctx.mode,
      playback: EXECUTABLE,
    };
  }

  return failure(manifest.id, policy.failureMessage(mismatches), {
    timing: ctx.timing,
    mode: ctx.mode,
    mismatches: policy.reportMismatches(mismatches),
  });
}

/**
 * Executable re-run: re-drive the inbound request, inject recorded dependency
 * responses, and compare the app response.
 * Defaults: strict match, instant timing. `diagnostic-lenient` continues after
 * safe soft mismatches and never labels a run with deviations as success.
 * `realtime` paces dependency completion from recorded timings (RFC §6).
 */
export async function runReplay(
  options: ReplayRunOptions,
): Promise<ReplayResult> {
  const timing: ReplayTimingMode = options.timing ?? "instant";
  const mode: ReplayMismatchMode = options.mode ?? "strict";

  const manifest = await loadManifest(options.storage, options.interactionId);
  const versionError = unsupportedSpecVersionMessage(manifest.specVersion);
  if (versionError) {
    return failure(manifest.id, versionError, { timing, mode });
  }

  const request = await buildInboundRequest(options.storage, manifest);
  const injection = installDependencyInjection({
    storage: options.storage,
    manifest,
    matching: mode,
    timing,
  });

  try {
    let response: Response;
    try {
      response = await options.handler(request);
    } catch (err) {
      return handlerFailure(err, injection, {
        manifestId: manifest.id,
        timing,
        mode,
      });
    }

    const priorMismatches = injection.takeMismatches();
    const timingNotes = injection.takeTimingNotes();
    if (injection.hadHardMismatch()) {
      return withTimingNotes(
        failure(
          manifest.id,
          firstMismatchMessage(priorMismatches, "dependency mismatch"),
          {
            timing,
            mode,
            mismatches: priorMismatches,
          },
        ),
        timingNotes,
      );
    }

    const compared = await compareToRecorded(
      options.storage,
      manifest,
      response,
      {
        timing,
        mode,
        priorMismatches,
      },
    );
    return withTimingNotes(compared, timingNotes);
  } finally {
    injection.restore();
  }
}
