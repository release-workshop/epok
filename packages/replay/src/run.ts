import { type InteractionManifest, type StorageProvider } from "@epok/core";
import {
  headersFromFields,
  installDependencyInjection,
  type FetchInjection,
} from "./inject.js";
import { unsupportedSpecVersionMessage } from "./compat.js";
import { loadManifest, resolveCasBytes } from "./load.js";
import type {
  ReplayMismatch,
  ReplayMismatchMode,
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

async function buildInboundRequest(
  storage: StorageProvider,
  manifest: InteractionManifest,
): Promise<Request> {
  const body = await resolveCasBytes(
    storage,
    manifest,
    manifest.inbound.body.cas,
  );
  const init: RequestInit = {
    method: manifest.inbound.method,
    headers: headersFromFields(manifest.inbound.headers),
  };
  // Fetch forbids a body on GET/HEAD.
  const method = manifest.inbound.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && body.byteLength > 0) {
    init.body = Uint8Array.from(body);
  }
  return new Request(manifest.inbound.url, init);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
  };
  if (options.mismatches !== undefined) {
    result.mismatches = options.mismatches;
  }
  return result;
}

function unsupportedModes(
  interactionId: string,
  timing: ReplayTimingMode,
  mode: ReplayMismatchMode,
): ReplayResult | undefined {
  if (timing !== "instant") {
    return failure(interactionId, `unsupported timing mode: ${timing}`, {
      timing: "instant",
      mode,
    });
  }
  if (mode !== "strict") {
    return failure(interactionId, `unsupported mismatch mode: ${mode}`, {
      timing,
      mode: "strict",
    });
  }
  return undefined;
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
  const mismatch = injection.takeMismatch();
  if (mismatch) {
    return failure(ctx.manifestId, mismatch.message, {
      timing: ctx.timing,
      mode: ctx.mode,
      mismatches: [mismatch],
    });
  }
  const message =
    err instanceof Error ? err.message : "handler threw during replay";
  return failure(ctx.manifestId, message, {
    timing: ctx.timing,
    mode: ctx.mode,
  });
}

async function compareToRecorded(
  storage: StorageProvider,
  manifest: InteractionManifest,
  response: Response,
  ctx: { timing: ReplayTimingMode; mode: ReplayMismatchMode },
): Promise<ReplayResult> {
  const actualBody = new Uint8Array(await response.arrayBuffer());
  const expectedBody = await resolveCasBytes(
    storage,
    manifest,
    manifest.response.body.cas,
  );

  if (response.status !== manifest.response.status) {
    const statusMismatch: ReplayMismatch = {
      code: "response_status_mismatch",
      message: `response status ${response.status} !== recorded ${manifest.response.status}`,
    };
    return failure(manifest.id, statusMismatch.message, {
      timing: ctx.timing,
      mode: ctx.mode,
      mismatches: [statusMismatch],
    });
  }

  if (!bytesEqual(actualBody, expectedBody)) {
    const bodyMismatch: ReplayMismatch = {
      code: "response_body_mismatch",
      message: "response body does not match recorded Interaction",
    };
    return failure(manifest.id, bodyMismatch.message, {
      timing: ctx.timing,
      mode: ctx.mode,
      mismatches: [bodyMismatch],
    });
  }

  return {
    ok: true,
    interactionId: manifest.id,
    message: "replay matched recorded Interaction",
    timing: ctx.timing,
    mode: ctx.mode,
  };
}

/**
 * Executable re-run: re-drive the inbound request, inject recorded dependency
 * responses (strict match, instant timing), and compare the app response.
 */
export async function runReplay(
  options: ReplayRunOptions,
): Promise<ReplayResult> {
  const timing: ReplayTimingMode = options.timing ?? "instant";
  const mode: ReplayMismatchMode = options.mode ?? "strict";
  const unsupported = unsupportedModes(options.interactionId, timing, mode);
  if (unsupported) return unsupported;

  const manifest = await loadManifest(options.storage, options.interactionId);
  const versionError = unsupportedSpecVersionMessage(manifest.specVersion);
  if (versionError) {
    return failure(manifest.id, versionError, { timing, mode });
  }

  const request = await buildInboundRequest(options.storage, manifest);
  const injection = installDependencyInjection({
    storage: options.storage,
    manifest,
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

    const mismatch = injection.takeMismatch();
    if (mismatch) {
      return failure(manifest.id, mismatch.message, {
        timing,
        mode,
        mismatches: [mismatch],
      });
    }

    return await compareToRecorded(options.storage, manifest, response, {
      timing,
      mode,
    });
  } finally {
    injection.restore();
  }
}
