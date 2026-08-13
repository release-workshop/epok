import { type StorageProvider } from "@epok/core";
import { installDependencyInjection, type FetchInjection } from "./inject.js";
import { unsupportedSpecVersionMessage } from "./compat.js";
import {
  hasObservedInboundResponse,
  inboundResponseMissingMismatch,
  INBOUND_RESPONSE_MISSING_MESSAGE,
} from "./incomplete.js";
import { buildInboundRequest, loadManifest, resolveCasBytes } from "./load.js";
import {
  applySignatureRegeneration,
  type ReplaySecrets,
} from "./signatures.js";
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
  /**
   * Local secrets keyed by Interaction `replay.signatures[].secretRef`.
   * Never read from the artifact (RFC §7).
   */
  secrets?: ReplaySecrets;
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
  if (manifest.response === null) {
    const missing = inboundResponseMissingMismatch();
    return failure(manifest.id, INBOUND_RESPONSE_MISSING_MESSAGE, {
      timing: ctx.timing,
      mode: ctx.mode,
      mismatches: [missing],
    });
  }
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

function withSignatureOutcomes(
  result: ReplayResult,
  signatureOutcomes: ReplayResult["signatureOutcomes"],
): ReplayResult {
  if (signatureOutcomes === undefined || signatureOutcomes.length === 0) {
    return result;
  }
  return { ...result, signatureOutcomes };
}

async function prepareExecutableManifest(
  options: ReplayRunOptions,
  timing: ReplayTimingMode,
  mode: ReplayMismatchMode,
): Promise<
  | {
      ok: true;
      manifest: Awaited<ReturnType<typeof loadManifest>>;
      outcomes: ReplayResult["signatureOutcomes"];
    }
  | { ok: false; result: ReplayResult }
> {
  const loaded = await loadManifest(options.storage, options.interactionId);
  const versionError = unsupportedSpecVersionMessage(loaded.specVersion);
  if (versionError) {
    return {
      ok: false,
      result: failure(loaded.id, versionError, { timing, mode }),
    };
  }

  const regenerated = await applySignatureRegeneration({
    storage: options.storage,
    manifest: loaded,
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
  });
  if (!regenerated.ok) {
    return {
      ok: false,
      result: withSignatureOutcomes(
        failure(
          loaded.id,
          regenerated.outcomes.find((o) => !o.ok)?.message ??
            "signature regeneration failed",
          { timing, mode },
        ),
        regenerated.outcomes,
      ),
    };
  }
  return {
    ok: true,
    manifest: regenerated.manifest,
    outcomes: regenerated.outcomes,
  };
}

/**
 * Executable re-run: re-drive the inbound request, inject recorded dependency
 * responses, and compare the app response.
 * Defaults: strict match, instant timing. `diagnostic-lenient` continues after
 * safe soft mismatches and never labels a run with deviations as success.
 * `realtime` paces dependency completion from recorded timings (RFC §6).
 * When `replay.signatures[]` is present, regenerates values from local
 * `secrets` before the handler runs (RFC §7).
 */
export async function runReplay(
  options: ReplayRunOptions,
): Promise<ReplayResult> {
  const timing: ReplayTimingMode = options.timing ?? "instant";
  const mode: ReplayMismatchMode = options.mode ?? "strict";

  const prepared = await prepareExecutableManifest(options, timing, mode);
  if (!prepared.ok) return prepared.result;

  const { manifest, outcomes } = prepared;
  if (!hasObservedInboundResponse(manifest)) {
    const missing = inboundResponseMissingMismatch();
    return withSignatureOutcomes(
      failure(manifest.id, INBOUND_RESPONSE_MISSING_MESSAGE, {
        timing,
        mode,
        mismatches: [missing],
      }),
      outcomes,
    );
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
      return withSignatureOutcomes(
        handlerFailure(err, injection, {
          manifestId: manifest.id,
          timing,
          mode,
        }),
        outcomes,
      );
    }

    const priorMismatches = injection.takeMismatches();
    const timingNotes = injection.takeTimingNotes();
    if (injection.hadHardMismatch()) {
      return withSignatureOutcomes(
        withTimingNotes(
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
        ),
        outcomes,
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
    return withSignatureOutcomes(
      withTimingNotes(compared, timingNotes),
      outcomes,
    );
  } finally {
    injection.restore();
  }
}
