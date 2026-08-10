import { createHash } from "node:crypto";
import type {
  CasRef,
  Dependency,
  EmbeddedObject,
  InteractionManifest,
  StorageProvider,
} from "@epok/core";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function casRefFor(
  bytes: Uint8Array,
  contentType: string | null,
): CasRef {
  return {
    alg: "sha256",
    hash: sha256Hex(bytes),
    size: bytes.byteLength,
    contentType,
    contentEncoding: null,
  };
}

export function embedUtf8(bytes: Uint8Array): EmbeddedObject {
  return { encoding: "utf-8", data: new TextDecoder().decode(bytes) };
}

export interface FixtureDependency {
  seq: number;
  method: string;
  url: string;
  responseBody: Uint8Array;
  responseStatus?: number;
  requestHeaders?: Array<{ name: string; value: string }>;
  requestBody?: Uint8Array;
}

/** Persist a minimal Interaction with one outbound dependency for replay tests. */
export async function persistReplayFixture(
  storage: StorageProvider,
  options: {
    id?: string;
    inboundUrl?: string;
    dependencyUrl?: string;
    dependencyMethod?: string;
    dependencyResponseBody?: Uint8Array;
    appResponseBody?: Uint8Array;
    appResponseStatus?: number;
  } = {},
): Promise<InteractionManifest> {
  return persistReplayFixtureWithDeps(storage, {
    id: options.id,
    inboundUrl: options.inboundUrl,
    appResponseBody: options.appResponseBody,
    appResponseStatus: options.appResponseStatus,
    dependencies: [
      {
        seq: 1,
        method: options.dependencyMethod ?? "GET",
        url: options.dependencyUrl ?? "https://api.example/quote",
        responseBody:
          options.dependencyResponseBody ??
          new TextEncoder().encode(JSON.stringify({ quote: 42 })),
      },
    ],
  });
}

/** Persist an Interaction with an explicit dependency list (incl. retries). */
export async function persistReplayFixtureWithDeps(
  storage: StorageProvider,
  options: {
    id?: string;
    inboundUrl?: string;
    dependencies: FixtureDependency[];
    appResponseBody?: Uint8Array;
    appResponseStatus?: number;
  },
): Promise<InteractionManifest> {
  const id = options.id ?? "01900000-0000-7000-8000-000000000011";
  const inboundBody = new Uint8Array();
  const appResponseBody =
    options.appResponseBody ??
    new TextEncoder().encode(JSON.stringify({ total: 42 }));

  const inboundCas = casRefFor(inboundBody, null);
  const emptyReqCas = casRefFor(new Uint8Array(), null);
  const appResCas = casRefFor(appResponseBody, "application/json");

  const objects: Record<string, EmbeddedObject> = {
    [inboundCas.hash]: embedUtf8(inboundBody),
    [emptyReqCas.hash]: embedUtf8(new Uint8Array()),
    [appResCas.hash]: embedUtf8(appResponseBody),
  };
  const integrityObjects = [
    { alg: "sha256" as const, hash: inboundCas.hash, size: inboundCas.size },
    { alg: "sha256" as const, hash: emptyReqCas.hash, size: emptyReqCas.size },
    { alg: "sha256" as const, hash: appResCas.hash, size: appResCas.size },
  ];

  const dependencies: Dependency[] = options.dependencies.map((dep, index) => {
    const depResCas = casRefFor(dep.responseBody, "application/json");
    objects[depResCas.hash] = embedUtf8(dep.responseBody);
    integrityObjects.push({
      alg: "sha256",
      hash: depResCas.hash,
      size: depResCas.size,
    });
    const reqBody = dep.requestBody ?? new Uint8Array();
    const depReqCas =
      reqBody.byteLength === 0 ? emptyReqCas : casRefFor(reqBody, null);
    if (reqBody.byteLength > 0) {
      objects[depReqCas.hash] = embedUtf8(reqBody);
      integrityObjects.push({
        alg: "sha256",
        hash: depReqCas.hash,
        size: depReqCas.size,
      });
    }
    return {
      seq: dep.seq,
      startedAt: index + 1,
      endedAt: index + 2,
      request: {
        protocol: "HTTP/1.1",
        method: dep.method,
        url: dep.url,
        headers: dep.requestHeaders ?? [],
        body: { cas: depReqCas },
      },
      response: {
        protocol: "HTTP/1.1",
        status: dep.responseStatus ?? 200,
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: { cas: depResCas },
      },
    };
  });

  const draft = {
    id,
    specVersion: "1.0.0",
    metadata: {
      capturedAt: "2026-08-07T12:00:00.000Z",
      recorder: { name: "@epok/recorder", version: "0.0.0" },
      runtime: { name: "node", version: "22.0.0" },
      sanitizer: { version: "0.0.0" },
      ruleset: { id: "epok.minimal", hash: "a".repeat(64) },
      captureMode: "full",
    },
    inbound: {
      protocol: "HTTP/1.1",
      method: "GET",
      url: options.inboundUrl ?? "https://app.example/total",
      headers: [],
      body: { cas: inboundCas },
    },
    dependencies,
    response: {
      protocol: "HTTP/1.1",
      status: options.appResponseStatus ?? 200,
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: { cas: appResCas },
      startedAt: dependencies.length + 1,
      endedAt: dependencies.length + 2,
    },
    replay: { signatures: [] },
    objects,
    integrity: {
      manifestHash: "",
      objects: integrityObjects,
    },
  };

  const manifestHash = sha256Hex(
    new TextEncoder().encode(JSON.stringify(draft)),
  );
  const manifest: InteractionManifest = {
    ...draft,
    integrity: { manifestHash, objects: integrityObjects },
  };

  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  await storage.putManifest({
    id: manifest.id,
    specVersion: manifest.specVersion,
    manifestHash,
    bytes,
  });

  return manifest;
}
