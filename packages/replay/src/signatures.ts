import { createHmac } from "node:crypto";
import type {
  HeaderField,
  InteractionManifest,
  SignatureHint,
  StorageProvider,
} from "@epok/core";
import { resolveCasBytes } from "./load.js";
import type { ReplayResult } from "./types.js";

export type ReplaySecrets = Readonly<Record<string, string>>;

export type SignatureOutcome = NonNullable<
  ReplayResult["signatureOutcomes"]
>[number];

const INBOUND_BODY = /^inbound\.body$/;
const INBOUND_HEADER = /^inbound\.headers\.(.+)$/;
const DEP_BODY = /^dependencies\[(\d+)\]\.request\.body$/;
const DEP_HEADER = /^dependencies\[(\d+)\]\.request\.headers\.(.+)$/;

function setHeader(
  headers: readonly HeaderField[],
  name: string,
  value: string,
): HeaderField[] {
  const lower = name.toLowerCase();
  const index = headers.findIndex(
    (field) => field.name.toLowerCase() === lower,
  );
  if (index < 0) {
    return [...headers, { name, value }];
  }
  return headers.map((field, i) =>
    i === index ? { name: field.name, value } : field,
  );
}

async function resolvePayloadBytes(
  storage: StorageProvider,
  manifest: InteractionManifest,
  payloadPath: string,
): Promise<Uint8Array> {
  if (INBOUND_BODY.test(payloadPath)) {
    return resolveCasBytes(storage, manifest, manifest.inbound.body.cas);
  }

  const depBody = DEP_BODY.exec(payloadPath);
  if (depBody) {
    const index = Number(depBody[1]);
    const dependency = manifest.dependencies[index];
    if (dependency === undefined) {
      throw new Error(`signature payload path not found: ${payloadPath}`);
    }
    return resolveCasBytes(storage, manifest, dependency.request.body.cas);
  }

  throw new Error(`unsupported signature payload path: ${payloadPath}`);
}

function signPayload(
  algorithm: string,
  secret: string,
  payload: Uint8Array,
): string {
  if (algorithm === "hmac-sha256") {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }
  throw new Error(`unsupported signature algorithm: ${algorithm}`);
}

function applyInboundHeader(
  manifest: InteractionManifest,
  headerName: string,
  value: string,
): InteractionManifest {
  return {
    ...manifest,
    inbound: {
      ...manifest.inbound,
      headers: setHeader(manifest.inbound.headers, headerName, value),
    },
  };
}

function applyDependencyHeader(
  manifest: InteractionManifest,
  index: number,
  headerName: string,
  value: string,
): InteractionManifest {
  const dependency = manifest.dependencies[index];
  if (dependency === undefined) {
    throw new Error(
      `signature target path not found: dependencies[${index}].request.headers.${headerName}`,
    );
  }
  const dependencies = manifest.dependencies.map((dep, i) => {
    if (i !== index) return dep;
    return {
      ...dep,
      request: {
        ...dep.request,
        headers: setHeader(dep.request.headers, headerName, value),
      },
    };
  });
  return { ...manifest, dependencies };
}

function applyTarget(
  manifest: InteractionManifest,
  target: string,
  value: string,
): InteractionManifest {
  const inboundHeader = INBOUND_HEADER.exec(target);
  if (inboundHeader) {
    const headerName = inboundHeader[1];
    if (headerName === undefined || headerName.length === 0) {
      throw new Error(`unsupported signature target path: ${target}`);
    }
    return applyInboundHeader(manifest, headerName, value);
  }

  const depHeader = DEP_HEADER.exec(target);
  if (depHeader) {
    const indexRaw = depHeader[1];
    const headerName = depHeader[2];
    if (
      indexRaw === undefined ||
      headerName === undefined ||
      headerName.length === 0
    ) {
      throw new Error(`unsupported signature target path: ${target}`);
    }
    return applyDependencyHeader(manifest, Number(indexRaw), headerName, value);
  }

  throw new Error(`unsupported signature target path: ${target}`);
}

/**
 * Apply `replay.signatures[]` using local secrets only (RFC §7).
 * Regenerated values are written onto a working manifest copy before matching
 * / inbound materialization. Secrets are never read from the Interaction.
 */
export async function applySignatureRegeneration(options: {
  storage: StorageProvider;
  manifest: InteractionManifest;
  secrets?: ReplaySecrets;
}): Promise<{
  manifest: InteractionManifest;
  outcomes: SignatureOutcome[];
  ok: boolean;
}> {
  const hints: readonly SignatureHint[] = options.manifest.replay.signatures;
  if (hints.length === 0) {
    return { manifest: options.manifest, outcomes: [], ok: true };
  }

  const secrets = options.secrets ?? {};
  let manifest = options.manifest;
  const outcomes: SignatureOutcome[] = [];
  let ok = true;

  for (const hint of hints) {
    const secret = secrets[hint.secretRef];
    if (secret === undefined || secret.length === 0) {
      ok = false;
      outcomes.push({
        secretRef: hint.secretRef,
        ok: false,
        message: `missing local secret for secretRef "${hint.secretRef}"`,
      });
      continue;
    }

    try {
      const payload = await resolvePayloadBytes(
        options.storage,
        manifest,
        hint.payload,
      );
      const value = signPayload(hint.algorithm, secret, payload);
      manifest = applyTarget(manifest, hint.target, value);
      outcomes.push({ secretRef: hint.secretRef, ok: true });
    } catch (err) {
      ok = false;
      outcomes.push({
        secretRef: hint.secretRef,
        ok: false,
        message:
          err instanceof Error ? err.message : "signature regeneration failed",
      });
    }
  }

  return { manifest, outcomes, ok };
}
