import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractionManifest } from "@epok/core";
import {
  listManifestIds,
  startDemo,
  type DemoHandle,
} from "../src/create-demo.js";

describe("demo app attach + filesystem persist", () => {
  let demo: DemoHandle | undefined;
  let storageDir: string | undefined;

  afterEach(async () => {
    await demo?.close();
    demo = undefined;
    if (storageDir !== undefined) {
      await rm(storageDir, { recursive: true, force: true });
      storageDir = undefined;
    }
  });

  it("persists one Interaction via attachRecorder when /fail returns 500", async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "epok-demo-"));
    demo = await startDemo({ storageDir });

    const res = await fetch(`${demo.url}/fail`, {
      headers: { "x-request-id": "demo-fail-1" },
    });
    expect(res.status).toBe(500);
    await demo.recorder.drain(2_000);

    const ids = await listManifestIds(storageDir);
    expect(ids).toHaveLength(1);

    const id = ids[0];
    expect(id).toBeDefined();
    if (id === undefined) return;
    const manifest = await readManifest(storageDir, id);
    expect(manifest.metadata.captureMode).toBe("errors");
    expect(manifest.response?.status).toBe(500);
    expect(manifest.dependencies.length).toBeGreaterThanOrEqual(1);
  });

  it("does not persist a successful /total request under default errors mode", async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "epok-demo-"));
    demo = await startDemo({ storageDir });

    const res = await fetch(`${demo.url}/total`, {
      headers: { "x-request-id": "demo-ok-1" },
    });
    expect(res.status).toBe(200);
    await demo.recorder.drain(2_000);

    expect(await listManifestIds(storageDir)).toHaveLength(0);
  });
});

async function readManifest(
  rootDir: string,
  id: string,
): Promise<InteractionManifest> {
  const bytes = await readFile(path.join(rootDir, "manifests", `${id}.json`));
  return JSON.parse(bytes.toString("utf8")) as InteractionManifest;
}
