import type { RecorderWideEvent } from "@epok/recorder";
import {
  DEFAULT_DEMO_STORAGE_DIR,
  DEFAULT_HANDLER_PATH,
  startDemo,
} from "./create-demo.js";

/**
 * Long-running standalone attach demo. Drive with curl, then CLI validate/run
 * (see README / docs/quickstart.md). Prefer `pnpm --filter @epok/demo golden`
 * for the automated end-to-end path.
 */
const storageDir = process.env.EPOK_STORAGE_DIR ?? DEFAULT_DEMO_STORAGE_DIR;
const port = Number(process.env.PORT ?? 3456);
const dependencyPort = Number(process.env.DEPENDENCY_PORT ?? 3457);

function logPersist(event: RecorderWideEvent): void {
  if (event.type !== "interaction_persisted") return;
  console.log(
    JSON.stringify({
      type: event.type,
      interactionId: event.interactionId,
      manifestHash: event.manifestHash,
      storageDir,
      next: [
        `pnpm --filter @epok/cli exec epok replay validate --dir ${storageDir} ${event.interactionId}`,
        `pnpm --filter @epok/cli exec epok replay run --dir ${storageDir} --handler ${DEFAULT_HANDLER_PATH} ${event.interactionId}`,
      ],
    }),
  );
}

const demo = await startDemo({
  storageDir,
  port,
  dependencyPort,
  onEvent: logPersist,
});

console.log(
  JSON.stringify({
    type: "demo_ready",
    url: demo.url,
    failUrl: `${demo.url}/fail`,
    dependency: demo.dependencyUrl,
    storageDir: demo.storageDir,
    captureMode: "errors",
    hint: `curl -s -H 'x-request-id: demo-1' ${demo.url}/fail`,
  }),
);

const shutdown = async (): Promise<void> => {
  await demo.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
