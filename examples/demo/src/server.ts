import { createServer } from "node:http";
import { attachRecorder, type RecorderWideEvent } from "@epok/recorder";
import type { StorageProvider } from "@epok/core";

/**
 * Observe-only demo: concurrent inbound requests each call one outbound fetch.
 * Wide events log inbound + dependency pairs keyed by interaction id.
 * Persist/sanitize land in later slices — storage is unused here.
 */
const unusedStorage: StorageProvider = {
  durability: "best-effort",
  putManifest: async () => {
    throw new Error("demo observe-only: storage not used");
  },
  getManifest: async () => {
    throw new Error("demo observe-only: storage not used");
  },
  putObject: async () => {
    throw new Error("demo observe-only: storage not used");
  },
  getObject: async () => {
    throw new Error("demo observe-only: storage not used");
  },
  hasObject: async () => {
    throw new Error("demo observe-only: storage not used");
  },
};

const port = Number(process.env.PORT ?? 3456);
const dependencyPort = Number(process.env.DEPENDENCY_PORT ?? 3457);

function logEvent(event: RecorderWideEvent): void {
  if (event.type === "observed" && event.phase === "inbound") {
    // Process-wide attach also observes the local dependency server; skip those.
    if (event.url.includes(`:${dependencyPort}/`)) return;
    const requestId = event.requestHeaders?.["x-request-id"] ?? "-";
    console.log(
      JSON.stringify({
        type: event.type,
        phase: event.phase,
        interactionId: event.interactionId,
        requestId,
        method: event.method,
        url: event.url,
      }),
    );
    return;
  }
  if (event.type === "observed" && event.phase === "dependency") {
    const requestId = new URL(event.url).searchParams.get("id") ?? "-";
    console.log(
      JSON.stringify({
        type: event.type,
        phase: event.phase,
        interactionId: event.interactionId,
        requestId,
        method: event.method,
        url: event.url,
        status: event.status,
      }),
    );
    return;
  }
  if (event.type === "context_missing" || event.type === "observation_dropped") {
    console.log(JSON.stringify(event));
  }
}

attachRecorder({
  storage: unusedStorage,
  onEvent: logEvent,
});

const dependency = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("dependency-ok\n");
});

await new Promise<void>((resolve, reject) => {
  dependency.listen(dependencyPort, "127.0.0.1", () => resolve());
  dependency.once("error", reject);
});

const server = createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] ?? "anon");
  const depUrl = `http://127.0.0.1:${dependencyPort}/dep?id=${encodeURIComponent(requestId)}`;
  const depRes = await fetch(depUrl);
  const depBody = await depRes.text();
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`ok requestId=${requestId} dep=${depBody.trim()}\n`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      type: "demo_ready",
      url: `http://127.0.0.1:${port}`,
      dependency: `http://127.0.0.1:${dependencyPort}`,
    }),
  );
});
