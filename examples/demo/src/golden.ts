import { runGolden } from "./golden-path.js";

/**
 * End-to-end golden path: attach server → HTTP `/fail` → filesystem persist →
 * validate → executable replay.
 */
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
