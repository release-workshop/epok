import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runGolden } from "../src/golden-path.js";

const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const handlerPath = path.join(demoRoot, "dist", "handler.js");

describe("demo golden orchestrator", () => {
  let storageDir: string | undefined;

  afterEach(async () => {
    if (storageDir !== undefined) {
      await rm(storageDir, { recursive: true, force: true });
      storageDir = undefined;
    }
  });

  it("records via attach HTTP /fail then CLI validate + run succeed", async () => {
    await access(handlerPath);
    storageDir = await mkdtemp(path.join(tmpdir(), "epok-demo-golden-"));

    const result = await runGolden({ storageDir, handlerPath });

    expect(result.interactionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.storageDir).toBe(storageDir);
  });
});
