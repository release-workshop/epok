import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachRecorder, type RecorderWideEvent } from "@epok/recorder";
import { createFsStorageProvider } from "@epok/storage-fs";
import { handleRequest } from "./handler.js";

/**
 * Long-running observe demo. Prefer `pnpm --filter @epok/demo golden` for the
 * record → persist → replay → validate path (see README / docs/quickstart.md).
 */
const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const storageDir =
  process.env.EPOK_STORAGE_DIR ?? path.join(demoRoot, ".epok-data");
const storage = createFsStorageProvider({ rootDir: storageDir });

const port = Number(process.env.PORT ?? 3456);
const dependencyPort = Number(process.env.DEPENDENCY_PORT ?? 3457);
const dependencyBase = `http://127.0.0.1:${dependencyPort}`;

function logEvent(event: RecorderWideEvent): void {
  if (event.type === "observed" && event.phase === "inbound") {
    if (event.url.includes(`:${dependencyPort}/`)) return;
    console.log(
      JSON.stringify({
        type: event.type,
        phase: event.phase,
        interactionId: event.interactionId,
        method: event.method,
        url: event.url,
      }),
    );
    return;
  }
  if (event.type === "observed" && event.phase === "dependency") {
    console.log(
      JSON.stringify({
        type: event.type,
        phase: event.phase,
        interactionId: event.interactionId,
        method: event.method,
        url: event.url,
        status: event.status,
      }),
    );
  }
}

attachRecorder({
  storage,
  // Demo/test-data path: persist successful Interactions too.
  captureMode: "full",
  onEvent: logEvent,
});

const dependency = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ quote: 42 }));
});

await new Promise<void>((resolve, reject) => {
  dependency.listen(dependencyPort, "127.0.0.1", () => {
    resolve();
  });
  dependency.once("error", reject);
});

const server = createServer((req, res) => {
  void handleInbound(req, res);
});

async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const host = req.headers.host ?? "127.0.0.1";
    const url = `http://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    if (!headers.has("x-epok-dependency-base")) {
      headers.set("x-epok-dependency-base", dependencyBase);
    }
    const request = new Request(url, { method: req.method ?? "GET", headers });
    const response = await handleRequest(request);
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : String(err));
  }
}
server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      type: "demo_ready",
      url: `http://127.0.0.1:${port}`,
      dependency: dependencyBase,
      storageDir,
      hint: "For record→persist→replay→validate, run: pnpm --filter @epok/demo golden",
    }),
  );
});
