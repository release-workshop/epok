import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HANDLER_PATH } from "../src/create-demo.js";
import { runGolden } from "../src/golden-path.js";

describe("demo golden orchestrator", () => {
  let storageDir: string | undefined;

  afterEach(async () => {
    if (storageDir !== undefined) {
      await rm(storageDir, { recursive: true, force: true });
      storageDir = undefined;
    }
  });

  it("records via attach HTTP /fail then CLI validate + run succeed", async () => {
    await access(DEFAULT_HANDLER_PATH);
    storageDir = await mkdtemp(path.join(tmpdir(), "epok-demo-golden-"));

    const result = await runGolden({
      storageDir,
      handlerPath: DEFAULT_HANDLER_PATH,
    });

    expect(result.interactionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.storageDir).toBe(storageDir);
  });
});
