import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EmbeddedObject,
  InteractionManifest,
  StorageProvider,
} from "@epok/core";
import { createFsStorageProvider } from "@epok/storage-fs";
import { runCli } from "../src/run.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function casRef(bytes: Uint8Array, contentType: string | null) {
  return {
    alg: "sha256" as const,
    hash: sha256Hex(bytes),
    size: bytes.byteLength,
    contentType,
    contentEncoding: null,
  };
}

function embed(bytes: Uint8Array): EmbeddedObject {
  return { encoding: "utf-8", data: new TextDecoder().decode(bytes) };
}

async function persistFixture(
  storage: StorageProvider,
  options: {
    id?: string;
    dependencyUrl?: string;
    appResponseBody?: Uint8Array;
  } = {},
): Promise<InteractionManifest> {
  const id = options.id ?? "01900000-0000-7000-8000-000000000021";
  const inboundBody = new Uint8Array();
  const emptyReq = new Uint8Array();
  const depRes = new TextEncoder().encode(JSON.stringify({ quote: 42 }));
  const appRes =
    options.appResponseBody ??
    new TextEncoder().encode(JSON.stringify({ total: 42 }));
  const depUrl = options.dependencyUrl ?? "https://api.example/quote";

  const inboundCas = casRef(inboundBody, null);
  const emptyCas = casRef(emptyReq, null);
  const depCas = casRef(depRes, "application/json");
  const appCas = casRef(appRes, "application/json");

  const objects: Record<string, EmbeddedObject> = {
    [inboundCas.hash]: embed(inboundBody),
    [emptyCas.hash]: embed(emptyReq),
    [depCas.hash]: embed(depRes),
    [appCas.hash]: embed(appRes),
  };
  const integrityObjects = [
    { alg: "sha256" as const, hash: inboundCas.hash, size: inboundCas.size },
    { alg: "sha256" as const, hash: emptyCas.hash, size: emptyCas.size },
    { alg: "sha256" as const, hash: depCas.hash, size: depCas.size },
    { alg: "sha256" as const, hash: appCas.hash, size: appCas.size },
  ];

  const draft = {
    id,
    specVersion: "1.0.0",
    metadata: {
      capturedAt: "2026-08-07T12:00:00.000Z",
      recorder: { name: "@epok/recorder", version: "0.0.0" },
      runtime: { name: "node", version: "22.0.0" },
      sanitizer: { version: "0.0.0" },
      ruleset: { id: "epok.minimal", hash: "a".repeat(64) },
      captureMode: "full",
    },
    inbound: {
      protocol: "HTTP/1.1",
      method: "GET",
      url: "https://app.example/total",
      headers: [],
      body: { cas: inboundCas },
    },
    dependencies: [
      {
        seq: 1,
        startedAt: 1,
        endedAt: 2,
        request: {
          protocol: "HTTP/1.1",
          method: "GET",
          url: depUrl,
          headers: [],
          body: { cas: emptyCas },
        },
        response: {
          protocol: "HTTP/1.1",
          status: 200,
          headers: [{ name: "Content-Type", value: "application/json" }],
          body: { cas: depCas },
        },
      },
    ],
    response: {
      protocol: "HTTP/1.1",
      status: 200,
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: { cas: appCas },
      startedAt: 3,
      endedAt: 4,
    },
    replay: { signatures: [] },
    objects,
    integrity: { manifestHash: "", objects: integrityObjects },
  };

  const manifestHash = sha256Hex(
    new TextEncoder().encode(JSON.stringify(draft)),
  );
  const manifest: InteractionManifest = {
    ...draft,
    integrity: { manifestHash, objects: integrityObjects },
  };
  await storage.putManifest({
    id: manifest.id,
    specVersion: manifest.specVersion,
    manifestHash,
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
  });
  return manifest;
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorageRoot(): Promise<{
  rootDir: string;
  storage: StorageProvider;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "epok-cli-"));
  tempDirs.push(rootDir);
  return { rootDir, storage: createFsStorageProvider({ rootDir }) };
}

describe("runCli", () => {
  it("validate prints a clear PASS and exits 0", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "validate",
      "--dir",
      rootDir,
      manifest.id,
    ]);

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/PASS/i);
    expect(out).toContain(manifest.id);
    expect(err).not.toHaveBeenCalled();
  });

  it("validate prints a clear FAIL and exits 1 when the Interaction is missing", async () => {
    const { rootDir } = await makeStorageRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "validate",
      "--dir",
      rootDir,
      "missing-id",
    ]);

    expect(code).toBe(1);
    const out = [...log.mock.calls, ...err.mock.calls]
      .map((c) => c.join(" "))
      .join("\n");
    expect(out).toMatch(/FAIL/i);
    expect(out).toMatch(/not found|missing/i);
  });

  it("run with a matching handler prints PASS and exits 0", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const handlerPath = path.join(rootDir, "handler.mjs");
    await writeFile(
      handlerPath,
      `export default async function handler() {
  const dep = await fetch("https://api.example/quote");
  const payload = await dep.json();
  return Response.json({ total: payload.quote });
}
`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "run",
      "--dir",
      rootDir,
      "--handler",
      handlerPath,
      manifest.id,
    ]);

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/PASS/i);
    expect(out).toContain(manifest.id);
  });

  it("run with a mismatched handler prints actionable FAIL and exits 1", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const handlerPath = path.join(rootDir, "bad-handler.mjs");
    await writeFile(
      handlerPath,
      `export default async function handler() {
  await fetch("https://api.example/wrong-path");
  return Response.json({ total: 0 });
}
`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "run",
      "--dir",
      rootDir,
      "--handler",
      handlerPath,
      manifest.id,
    ]);

    expect(code).toBe(1);
    const out = [...log.mock.calls, ...err.mock.calls]
      .map((c) => c.join(" "))
      .join("\n");
    expect(out).toMatch(/FAIL/i);
    expect(out).toMatch(/dependency_mismatch|no recorded dependency/i);
    expect(out).toContain("https://api.example/wrong-path");
  });

  it("supports --report json", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "validate",
      "--dir",
      rootDir,
      "--report",
      "json",
      manifest.id,
    ]);

    expect(code).toBe(0);
    const raw = String(log.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      interactionId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.interactionId).toBe(manifest.id);
  });

  it("rejects run without --handler", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli([
      "node",
      "epok",
      "replay",
      "run",
      "01900000-0000-7000-8000-000000000021",
    ]);
    expect(code).toBe(2);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
      /--handler/,
    );
  });

  it("mock loads snapshot fixtures without --handler and exits 0", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "mock",
      "--dir",
      rootDir,
      "--report",
      "json",
      manifest.id,
    ]);

    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalled();
    const raw = String(log.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      playback: string;
      dependencyCount: number;
      interactionId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.playback).toBe("snapshot");
    expect(parsed.dependencyCount).toBe(1);
    expect(parsed.interactionId).toBe(manifest.id);
  });

  it("run --mode diagnostic-lenient reports soft dependency mismatch and exits 1", async () => {
    const { rootDir, storage } = await makeStorageRoot();
    const manifest = await persistFixture(storage);
    const handlerPath = path.join(rootDir, "lenient-handler.mjs");
    await writeFile(
      handlerPath,
      `export default async function handler() {
  const dep = await fetch("https://api.example/quote-v2");
  const payload = await dep.json();
  return Response.json({ total: payload.quote });
}
`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runCli([
      "node",
      "epok",
      "replay",
      "run",
      "--dir",
      rootDir,
      "--handler",
      handlerPath,
      "--mode",
      "diagnostic-lenient",
      "--report",
      "json",
      manifest.id,
    ]);

    expect(code).toBe(1);
    const raw = String(err.mock.calls[0]?.[0] ?? log.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      mode: string;
      mismatches?: Array<{
        code: string;
        url?: string;
        dependencySeq?: number;
      }>;
      message: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.mode).toBe("diagnostic-lenient");
    expect(parsed.message).toMatch(/diagnostic/i);
    expect(parsed.mismatches).toEqual([
      expect.objectContaining({
        code: "dependency_mismatch",
        url: "https://api.example/quote-v2",
        dependencySeq: 1,
      }),
    ]);
  });
});
