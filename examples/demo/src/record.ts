import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import {
  finalizeObservation,
  type ObservedCapture,
  type ObservedDependency,
  type ObservedHttpRequest,
} from "@epok/recorder";
import { createFsStorageProvider } from "@epok/storage-fs";
import type { HeaderField, StorageProvider } from "@epok/core";
import { handleRequest } from "./handler.js";

const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultStorageDir = path.join(demoRoot, ".epok-data");

function headersToFields(headers: Headers): HeaderField[] {
  const fields: HeaderField[] = [];
  headers.forEach((value, name) => {
    fields.push({ name, value });
  });
  return fields;
}

function requestToObserved(
  request: Request,
  body: Uint8Array,
): ObservedHttpRequest {
  return {
    protocol: "HTTP/1.1",
    method: request.method,
    url: request.url,
    headers: headersToFields(request.headers),
    body,
    contentType: request.headers.get("content-type"),
  };
}

async function persistFinalized(
  storage: StorageProvider,
  capture: ObservedCapture,
): Promise<{ interactionId: string; manifestHash: string }> {
  const finalized = finalizeObservation(capture);
  if (finalized === null) {
    throw new Error("finalizeObservation dropped the Interaction");
  }

  for (const [hash, bytes] of Object.entries(finalized.externalObjects)) {
    await storage.putObject({ alg: "sha256", hash }, bytes);
  }

  const bytes = new TextEncoder().encode(JSON.stringify(finalized.manifest));
  await storage.putManifest({
    id: finalized.manifest.id,
    specVersion: finalized.manifest.specVersion,
    manifestHash: finalized.manifest.integrity.manifestHash,
    bytes,
  });

  return {
    interactionId: finalized.manifest.id,
    manifestHash: finalized.manifest.integrity.manifestHash,
  };
}

async function startDependencyServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ quote: 42 }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
        return;
      }
      reject(new Error("dependency server failed to bind"));
    });
    server.once("error", reject);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/**
 * Record one Interaction: live dependency call → sanitize/finalize → filesystem
 * Storage Provider. Prints the id and next CLI commands for first-run success.
 */
export async function recordOnce(
  storageDir = process.env.EPOK_STORAGE_DIR ?? defaultStorageDir,
): Promise<{
  interactionId: string;
  storageDir: string;
  manifestHash: string;
}> {
  await mkdir(storageDir, { recursive: true });
  const storage = createFsStorageProvider({ rootDir: storageDir });
  const dependency = await startDependencyServer();

  const interactionId = randomUUID();
  const inboundRequest = new Request("http://127.0.0.1/total", {
    method: "GET",
    headers: {
      "x-request-id": "demo-1",
      "x-epok-dependency-base": dependency.baseUrl,
      accept: "application/json",
    },
  });
  const inboundBody = new Uint8Array();

  const dependencies: ObservedDependency[] = [];
  const originalFetch = globalThis.fetch;
  let seq = 0;

  globalThis.fetch = async (input, init) => {
    const startedAt = seq * 2 + 1;
    const request = new Request(input, init);
    const response = await originalFetch(input, init);
    const resBody = new Uint8Array(await response.clone().arrayBuffer());
    const endedAt = startedAt + 1;
    seq += 1;
    dependencies.push({
      seq,
      startedAt,
      endedAt,
      request: requestToObserved(request, new Uint8Array()),
      response: {
        protocol: "HTTP/1.1",
        status: response.status,
        statusText: response.statusText,
        headers: headersToFields(response.headers),
        body: resBody,
        contentType: response.headers.get("content-type"),
      },
    });
    return response;
  };

  try {
    const response = await handleRequest(inboundRequest);
    const responseBody = new Uint8Array(await response.clone().arrayBuffer());
    const responseEndedAt = Math.max(2, seq * 2 + 1);

    const capture: ObservedCapture = {
      id: interactionId,
      capturedAt: new Date().toISOString(),
      captureMode: "full",
      inbound: requestToObserved(inboundRequest, inboundBody),
      dependencies,
      response: {
        protocol: "HTTP/1.1",
        status: response.status,
        statusText: response.statusText,
        headers: headersToFields(response.headers),
        body: responseBody,
        contentType: response.headers.get("content-type"),
        startedAt: 1,
        endedAt: responseEndedAt,
      },
    };

    const persisted = await persistFinalized(storage, capture);
    return {
      interactionId: persisted.interactionId,
      storageDir,
      manifestHash: persisted.manifestHash,
    };
  } finally {
    globalThis.fetch = originalFetch;
    await dependency.close();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const result = await recordOnce();
  const handlerPath = path.join(demoRoot, "dist", "handler.js");
  console.log(
    JSON.stringify({
      type: "recorded",
      interactionId: result.interactionId,
      storageDir: result.storageDir,
      manifestHash: result.manifestHash,
    }),
  );
  console.log("");
  console.log("Next:");
  console.log(
    `  pnpm --filter @epok/cli exec epok replay validate --dir ${result.storageDir} ${result.interactionId}`,
  );
  console.log(
    `  pnpm --filter @epok/cli exec epok replay run --dir ${result.storageDir} --handler ${handlerPath} ${result.interactionId}`,
  );
}
