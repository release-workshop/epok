import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "@epok/cli";
import {
  DEFAULT_DEMO_STORAGE_DIR,
  DEFAULT_HANDLER_PATH,
  listManifestIds,
  startDemo,
  type StartDemoOptions,
} from "./create-demo.js";

export interface RunGoldenOptions extends StartDemoOptions {
  /** Handler module path for `epok replay run` (compiled ESM). */
  handlerPath?: string;
}

export interface GoldenResult {
  interactionId: string;
  storageDir: string;
}

/**
 * Golden path: start attach demo → HTTP `/fail` → Interaction on disk →
 * `epok replay validate` → `epok replay run`.
 */
export async function runGolden(
  options: RunGoldenOptions = {},
): Promise<GoldenResult> {
  const storageDir = path.resolve(
    options.storageDir ?? DEFAULT_DEMO_STORAGE_DIR,
  );
  const handlerPath = options.handlerPath ?? DEFAULT_HANDLER_PATH;

  // Fresh clone / re-run: keep exactly one Interaction for the golden story.
  await rm(storageDir, { recursive: true, force: true });

  const demo = await startDemo({
    storageDir,
    port: options.port ?? 0,
    dependencyPort: options.dependencyPort ?? 0,
  });

  try {
    const res = await fetch(`${demo.url}/fail`, {
      headers: { "x-request-id": "golden-1" },
    });
    if (res.status !== 500) {
      throw new Error(`expected /fail to return 500, got ${res.status}`);
    }
    await demo.recorder.drain(2_000);

    const interactionId = await waitForSingleManifest(storageDir);
    const validateCode = await runCli([
      "node",
      "epok",
      "replay",
      "validate",
      "--dir",
      storageDir,
      interactionId,
    ]);
    if (validateCode !== 0) {
      throw new Error(`epok replay validate failed with exit ${validateCode}`);
    }

    const runCode = await runCli([
      "node",
      "epok",
      "replay",
      "run",
      "--dir",
      storageDir,
      "--handler",
      handlerPath,
      interactionId,
    ]);
    if (runCode !== 0) {
      throw new Error(`epok replay run failed with exit ${runCode}`);
    }

    return { interactionId, storageDir };
  } finally {
    await demo.close();
  }
}

async function waitForSingleManifest(
  storageDir: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = await listManifestIds(storageDir);
    if (ids.length === 1) {
      const only = ids[0];
      if (only === undefined) {
        throw new Error(`expected a manifest id under ${storageDir}`);
      }
      return only;
    }
    if (ids.length > 1) {
      throw new Error(
        `expected exactly one Interaction under ${storageDir}, found ${ids.length.toString()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `no Interaction persisted under ${storageDir} within ${timeoutMs.toString()}ms`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runGolden();
  console.log(
    JSON.stringify({
      type: "recorded",
      interactionId: result.interactionId,
      storageDir: result.storageDir,
    }),
  );
  console.log(
    JSON.stringify({
      type: "golden_ok",
      interactionId: result.interactionId,
      storageDir: result.storageDir,
    }),
  );
}
