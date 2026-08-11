/**
 * Bun runtime smoke — run with `pnpm --filter @epok/recorder test:bun`.
 * Vitest covers the same attach path on Node; this proves Bun.serve + fetch under Bun.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { InteractionManifest } from "@epok/core";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import {
  attachBunRecorder,
  type BunRecorderHandle,
  type RecorderWideEvent,
} from "../src/bun.js";

describe("Bun.serve runtime proof", () => {
  let recorder: BunRecorderHandle;
  let server: ReturnType<typeof Bun.serve>;
  let depServer: ReturnType<typeof Bun.serve>;
  const events: RecorderWideEvent[] = [];
  const storage = createMemoryStorageProvider();

  beforeAll(() => {
    recorder = attachBunRecorder({
      storage,
      captureMode: "full",
      onEvent: (event) => {
        events.push(event);
      },
    });

    depServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const id = new URL(req.url).searchParams.get("id") ?? "0";
        return Response.json({ quote: Number(id.replace(/\D/g, "") || 0) });
      },
    });

    const depBase = `http://127.0.0.1:${depServer.port}`;

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: recorder.wrapHandler(async (request) => {
        const id = request.headers.get("x-request-id") ?? "0";
        const dep = await fetch(
          `${depBase}/quote?id=${encodeURIComponent(id)}`,
        );
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ requestId: id, total: payload.quote });
      }),
    });
  });

  afterAll(async () => {
    await recorder.drain(2_000);
    recorder.detach();
    server.stop(true);
    depServer.stop(true);
  });

  test("records inbound + dependency through Bun.serve", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/total`, {
      headers: { "x-request-id": "9" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requestId: "9", total: 9 });

    await recorder.drain(2_000);

    const persisted = events.filter((e) => e.type === "interaction_persisted");
    expect(persisted).toHaveLength(1);

    const interactionId = persisted[0]?.interactionId;
    expect(interactionId).toBeDefined();
    const manifestBytes = await storage.getManifest(interactionId as string);
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as InteractionManifest;

    expect(manifest.inbound.method).toBe("GET");
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.metadata.runtime.name).toBe("bun");
    expect(manifest.metadata.runtime.version).not.toBe("unknown");
  });

  test("does not surface recorder hook failures as host handler failures", async () => {
    const failOpenEvents: RecorderWideEvent[] = [];
    const failOpen = attachBunRecorder({
      storage: createMemoryStorageProvider(),
      captureMode: "full",
      hooks: {
        onInbound() {
          throw new Error("hook boom");
        },
      },
      onEvent: (event) => {
        failOpenEvents.push(event);
      },
    });

    const failOpenServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: failOpen.wrapHandler(async () => Response.json({ ok: true })),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${failOpenServer.port}/`);
      expect(response.status).toBe(200);
      expect(
        failOpenEvents.some(
          (e) =>
            e.type === "observation_dropped" && e.reason === "observer_threw",
        ),
      ).toBe(true);
    } finally {
      await failOpen.drain(500);
      failOpen.detach();
      failOpenServer.stop(true);
    }
  });
});
