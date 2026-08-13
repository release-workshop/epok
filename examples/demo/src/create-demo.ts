import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachRecorder,
  type RecorderHandle,
  type RecorderWideEvent,
} from "@epok/recorder";
import { createFsStorageProvider } from "@epok/storage-fs";
import { handleRequest } from "./handler.js";

export const DEMO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const DEFAULT_DEMO_STORAGE_DIR = path.join(DEMO_ROOT, ".epok-data");
export const DEFAULT_HANDLER_PATH = path.join(DEMO_ROOT, "dist", "handler.js");

export interface StartDemoOptions {
  /** Filesystem Storage Provider root. Defaults to `examples/demo/.epok-data`. */
  storageDir?: string;
  /** App listen port; `0` (default) picks an ephemeral port. */
  port?: number;
  /** Dependency listen port; `0` (default) picks an ephemeral port. */
  dependencyPort?: number;
  /** Opt-in wide events (e.g. log `interaction_persisted` for the curl path). */
  onEvent?: (event: RecorderWideEvent) => void;
}

export interface DemoHandle {
  url: string;
  dependencyUrl: string;
  storageDir: string;
  recorder: RecorderHandle;
  close(): Promise<void>;
}

/**
 * Start a standalone no-framework Node HTTP demo with `attachRecorder` and
 * filesystem storage. Uses default `captureMode: "errors"` so only failing
 * inbound responses (e.g. `GET /fail`) are persisted.
 */
export async function startDemo(
  options: StartDemoOptions = {},
): Promise<DemoHandle> {
  const storageDir = path.resolve(
    options.storageDir ?? DEFAULT_DEMO_STORAGE_DIR,
  );
  await mkdir(storageDir, { recursive: true });
  const storage = createFsStorageProvider({ rootDir: storageDir });
  const recorder = attachRecorder({
    storage,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  const dependency = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ quote: 42 }));
  });
  await listen(dependency, options.dependencyPort ?? 0);
  const dependencyUrl = addressOf(dependency);

  const server = createServer((req, res) => {
    void handleInbound(req, res, dependencyUrl);
  });
  await listen(server, options.port ?? 0);
  const url = addressOf(server);

  return {
    url,
    dependencyUrl,
    storageDir,
    recorder,
    async close(): Promise<void> {
      await recorder.drain(2_000);
      recorder.detach();
      await Promise.all([closeServer(server), closeServer(dependency)]);
    },
  };
}

async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  dependencyBase: string,
): Promise<void> {
  try {
    // Stamp onto the Node request so attachRecorder persists it for replay.
    if (req.headers["x-epok-dependency-base"] === undefined) {
      req.headers["x-epok-dependency-base"] = dependencyBase;
    }
    const request = nodeToFetchRequest(req);
    const response = await handleRequest(request);
    await writeFetchResponse(res, response);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : String(err));
  }
}

function nodeToFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(url, { method: req.method ?? "GET", headers });
}

async function writeFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  res.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
    server.once("error", reject);
  });
}

function addressOf(server: Server): string {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server has no TCP address");
  }
  return `http://127.0.0.1:${addr.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Interaction ids from `manifests/<id>.json` under a filesystem Storage Provider root. */
export async function listManifestIds(rootDir: string): Promise<string[]> {
  const dir = path.join(rootDir, "manifests");
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
