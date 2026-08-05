import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike, RecorderObservationHooks } from "../src/index.js";

const coreSrcDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("core runtime boundary", () => {
  it("does not import Node-only modules from @epok/core sources", async () => {
    const files = await listTsFiles(coreSrcDir);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        /\bfrom\s+["']node:/.test(source) ||
        /\bimport\s+["']node:/.test(source) ||
        /\brequire\s*\(\s*["']node:/.test(source) ||
        /\bfrom\s+["'](?:fs|http|https|net|tls|child_process|worker_threads)["']/.test(
          source,
        )
      ) {
        offenders.push(path.relative(coreSrcDir, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("exposes Fetch-shaped observation hooks usable without Node http types", () => {
    const calls: string[] = [];

    const hooks: RecorderObservationHooks = {
      onInbound(request) {
        calls.push(`in:${request.method}`);
      },
      onDependency(request, response) {
        calls.push(`dep:${request.method}:${response?.status ?? "err"}`);
      },
      onResponse(response) {
        calls.push(`out:${response.status}`);
      },
    };

    const fetchLike: FetchLike = async (input) => {
      const request =
        input instanceof Request ? input : new Request(String(input));
      hooks.onInbound?.(request);
      const dependencyRequest = new Request("https://api.test/dep");
      const dependencyResponse = new Response("ok", { status: 200 });
      hooks.onDependency?.(dependencyRequest, dependencyResponse);
      const response = new Response("hello", { status: 200 });
      hooks.onResponse?.(response);
      return response;
    };

    return fetchLike("https://example.test/").then((response) => {
      expect(response.status).toBe(200);
      expect(calls).toEqual(["in:GET", "dep:GET:200", "out:200"]);
    });
  });
});
