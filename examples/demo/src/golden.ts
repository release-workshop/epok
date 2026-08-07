import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "@epok/cli";
import { recordOnce } from "./record.js";

const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const handlerPath = path.join(demoRoot, "dist", "handler.js");

/**
 * End-to-end golden path: record → persist (filesystem) → validate → replay.
 */
const recorded = await recordOnce();
console.log(
  JSON.stringify({
    type: "recorded",
    interactionId: recorded.interactionId,
    storageDir: recorded.storageDir,
    manifestHash: recorded.manifestHash,
  }),
);

const validateCode = await runCli([
  "node",
  "epok",
  "replay",
  "validate",
  "--dir",
  recorded.storageDir,
  recorded.interactionId,
]);
if (validateCode !== 0) {
  process.exitCode = validateCode;
  throw new Error(`epok replay validate failed with exit ${validateCode}`);
}

const runCode = await runCli([
  "node",
  "epok",
  "replay",
  "run",
  "--dir",
  recorded.storageDir,
  "--handler",
  handlerPath,
  recorded.interactionId,
]);
if (runCode !== 0) {
  process.exitCode = runCode;
  throw new Error(`epok replay run failed with exit ${runCode}`);
}

console.log(
  JSON.stringify({
    type: "golden_ok",
    interactionId: recorded.interactionId,
    storageDir: recorded.storageDir,
  }),
);
