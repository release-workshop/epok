import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  StorageError,
  type CasKey,
  type PutManifestInput,
  type StorageErrorCode,
  type StorageProvider,
} from "@epok/core";
import { createMemoryStorageProvider } from "../../storage-memory/src/index.js";
import { describeStorageProviderContract } from "../../core/tests/storage-provider-contract.js";
import { createRemoteStorageProvider } from "../src/index.js";

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body?: Uint8Array | string,
  headers?: Record<string, string>,
): void {
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? Buffer.from(body)
        : Buffer.from(body);
  res.writeHead(status, {
    ...(payload ? { "content-length": String(payload.byteLength) } : {}),
    ...headers,
  });
  res.end(payload);
}

function parseCasKey(alg: string, hash: string): CasKey {
  if (alg !== "sha256") {
    throw new StorageError("integrity", `unsupported CAS alg: ${alg}`);
  }
  return { alg, hash };
}

const ERROR_STATUS: Record<StorageErrorCode, number> = {
  not_found: 404,
  integrity: 422,
  unauthorized: 401,
  timeout: 504,
  quota: 507,
  unavailable: 503,
};

function sendStorageError(res: ServerResponse, err: StorageError): void {
  send(res, ERROR_STATUS[err.code], err.message, {
    "content-type": "text/plain",
    "x-epok-storage-error": err.code,
  });
}

async function handleManifest(
  backend: StorageProvider,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<boolean> {
  if (req.method === "PUT") {
    const bytes = await readBody(req);
    const input: PutManifestInput = {
      id,
      specVersion: String(req.headers["x-epok-spec-version"] ?? ""),
      manifestHash: String(req.headers["x-epok-manifest-hash"] ?? ""),
      bytes,
    };
    await backend.putManifest(input);
    send(res, 204);
    return true;
  }
  if (req.method === "GET") {
    const bytes = await backend.getManifest(id);
    send(res, 200, bytes, { "content-type": "application/octet-stream" });
    return true;
  }
  return false;
}

async function handleObject(
  backend: StorageProvider,
  req: IncomingMessage,
  res: ServerResponse,
  key: CasKey,
): Promise<boolean> {
  if (req.method === "PUT") {
    const bytes = await readBody(req);
    const result = await backend.putObject(key, bytes);
    send(res, 200, JSON.stringify(result), {
      "content-type": "application/json",
    });
    return true;
  }
  if (req.method === "GET") {
    const bytes = await backend.getObject(key);
    send(res, 200, bytes, { "content-type": "application/octet-stream" });
    return true;
  }
  if (req.method === "HEAD") {
    send(res, (await backend.hasObject(key)) ? 200 : 404);
    return true;
  }
  return false;
}

function pathPartsUnderPrefix(
  pathname: string,
  prefix: string,
): string[] | null {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  return pathname.slice(prefix.length).split("/").filter(Boolean);
}

async function handleRoutedRequest(
  backend: StorageProvider,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<boolean> {
  if (parts[0] === "manifests" && parts[1] && parts.length === 2) {
    return handleManifest(backend, req, res, decodeURIComponent(parts[1]));
  }
  if (parts[0] === "objects" && parts[1] && parts[2] && parts.length === 3) {
    return handleObject(backend, req, res, parseCasKey(parts[1], parts[2]));
  }
  return false;
}

async function dispatchRemoteRequest(
  backend: StorageProvider,
  req: IncomingMessage,
  res: ServerResponse,
  prefix: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = pathPartsUnderPrefix(url.pathname, prefix);
  if (!parts) {
    send(res, 404, "not found");
    return;
  }

  if (!(await handleRoutedRequest(backend, req, res, parts))) {
    send(res, 404, "not found");
  }
}

/** Persistence-only HTTP façade over an in-memory Storage Provider. */
function createTestRemoteServer(
  backend: StorageProvider,
  basePath = "/epok",
): Server {
  const prefix = basePath.replace(/\/+$/, "");
  return createServer((req, res) => {
    void dispatchRemoteRequest(backend, req, res, prefix).catch(
      (err: unknown) => {
        if (err instanceof StorageError) {
          sendStorageError(res, err);
          return;
        }
        send(res, 500, err instanceof Error ? err.message : "error");
      },
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describeStorageProviderContract("remote", async () => {
  const server = createTestRemoteServer(createMemoryStorageProvider());
  const origin = await listen(server);
  return {
    provider: createRemoteStorageProvider({ endpoint: `${origin}/epok` }),
    cleanup: async () => {
      await close(server);
    },
  };
});
