import type { StorageProvider } from "@epok/core";
import { installDependencyInjection, type FetchInjection } from "./inject.js";
import { unsupportedSpecVersionMessage } from "./compat.js";
import {
  buildInboundRequest,
  buildRecordedResponse,
  loadManifest,
} from "./load.js";
import {
  applySignatureRegeneration,
  type ReplaySecrets,
} from "./signatures.js";
import type {
  ReplayMismatchMode,
  ReplayResult,
  ReplayTimingMode,
} from "./types.js";

export interface MockReplayOptions {
  storage: StorageProvider;
  interactionId: string;
  timing?: ReplayTimingMode;
  mode?: ReplayMismatchMode;
  /** Local secrets for `replay.signatures[]` (RFC §7). */
  secrets?: ReplaySecrets;
}

/** Snapshot fixtures loaded from an Interaction (no executable re-drive). */
export interface MockReplayReady {
  ok: true;
  playback: "snapshot";
  interactionId: string;
  message: string;
  timing: ReplayTimingMode;
  mode: ReplayMismatchMode;
  /** Recorded inbound Request fixture (not re-driven). */
  inbound: Request;
  /** Recorded terminal application Response fixture. */
  recordedResponse: Response;
  dependencyCount: number;
  signatureOutcomes?: ReplayResult["signatureOutcomes"];
  /**
   * Install `fetch` injection with hybrid snapshot matching.
   * Never forwards to the network. Caller must `restore()`.
   */
  installFetch: () => FetchInjection;
}

export type MockReplayResult =
  MockReplayReady | (ReplayResult & { ok: false; playback: "snapshot" });

function failure(
  interactionId: string,
  message: string,
  options: {
    timing: ReplayTimingMode;
    mode: ReplayMismatchMode;
    playback: "snapshot";
  },
): ReplayResult & { ok: false; playback: "snapshot" } {
  return {
    ok: false,
    interactionId,
    message,
    timing: options.timing,
    mode: options.mode,
    playback: options.playback,
  };
}

function unsupportedModes(
  interactionId: string,
  timing: ReplayTimingMode,
  mode: ReplayMismatchMode,
): (ReplayResult & { ok: false; playback: "snapshot" }) | undefined {
  if (mode !== "strict") {
    return failure(interactionId, `unsupported mismatch mode: ${mode}`, {
      timing,
      mode: "strict",
      playback: "snapshot",
    });
  }
  return undefined;
}

/**
 * Snapshot/mock playback: materialize inbound/response fixtures and serve
 * recorded dependency responses without executable re-drive of the app path.
 * Timing applies when `installFetch()` injects dependencies.
 */
export async function mockReplay(
  options: MockReplayOptions,
): Promise<MockReplayResult> {
  const timing: ReplayTimingMode = options.timing ?? "instant";
  const mode: ReplayMismatchMode = options.mode ?? "strict";
  const unsupported = unsupportedModes(options.interactionId, timing, mode);
  if (unsupported) return unsupported;

  const loaded = await loadManifest(options.storage, options.interactionId);
  const versionError = unsupportedSpecVersionMessage(loaded.specVersion);
  if (versionError) {
    return failure(loaded.id, versionError, {
      timing,
      mode,
      playback: "snapshot",
    });
  }

  const regenerated = await applySignatureRegeneration({
    storage: options.storage,
    manifest: loaded,
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
  });
  if (!regenerated.ok) {
    return {
      ...failure(
        loaded.id,
        regenerated.outcomes.find((o) => !o.ok)?.message ??
          "signature regeneration failed",
        { timing, mode, playback: "snapshot" },
      ),
      signatureOutcomes: regenerated.outcomes,
    };
  }

  const manifest = regenerated.manifest;
  const inbound = await buildInboundRequest(options.storage, manifest);
  const recordedResponse = await buildRecordedResponse(
    options.storage,
    manifest,
  );

  const ready: MockReplayReady = {
    ok: true,
    playback: "snapshot",
    interactionId: manifest.id,
    message: "snapshot fixtures ready (no executable re-drive)",
    timing,
    mode,
    inbound,
    recordedResponse,
    dependencyCount: manifest.dependencies.length,
    installFetch: () =>
      installDependencyInjection({
        storage: options.storage,
        manifest,
        matching: "snapshot",
        timing,
      }),
  };
  if (regenerated.outcomes.length > 0) {
    ready.signatureOutcomes = regenerated.outcomes;
  }
  return ready;
}
