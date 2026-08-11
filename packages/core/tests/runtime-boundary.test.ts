import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreSrcRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

describe("@epok/core runtime boundary", () => {
  it("does not import Node-only modules under src/", async () => {
    const offenders: string[] = [];
    await scanDir(coreSrcRoot, offenders);
    expect(offenders).toEqual([]);
  });
});

async function scanDir(dir: string, offenders: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(fullPath, offenders);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = await readFile(fullPath, "utf8");
    if (/from\s+["']node:/.test(source) || /import\s+["']node:/.test(source)) {
      offenders.push(path.relative(coreSrcRoot, fullPath));
    }
  }
}
