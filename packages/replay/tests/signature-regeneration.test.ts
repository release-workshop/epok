import { describe, expect, it } from "vitest";
import { REDACTION_SENTINEL } from "@epok/core";
import { createMemoryStorageProvider } from "@epok/storage-memory";
import { runReplay } from "../src/index.js";
import { persistReplayFixtureWithDeps } from "./helpers.js";

// Independent known-good HMAC-SHA256 of '{"event":"paid"}' with secret whsec_test.
const EXPECTED_INBOUND_HMAC =
  "b85236760a6447cd065efe2b7bd10554c3744eff60cc53dfa47a639c5fd1e22c";

describe("signature regeneration", () => {
  it("regenerates inbound HMAC before the handler runs and reports outcomes", async () => {
    const storage = createMemoryStorageProvider();
    const inboundBody = new TextEncoder().encode(
      JSON.stringify({ event: "paid" }),
    );
    const appBody = new TextEncoder().encode(JSON.stringify({ ok: true }));

    const manifest = await persistReplayFixtureWithDeps(storage, {
      inboundMethod: "POST",
      inboundUrl: "https://app.example/webhook",
      inboundBody,
      inboundHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Hub-Signature-256", value: REDACTION_SENTINEL },
      ],
      signatures: [
        {
          target: "inbound.headers.X-Hub-Signature-256",
          algorithm: "hmac-sha256",
          payload: "inbound.body",
          secretRef: "payments.webhook.secret",
          replaced: true,
        },
      ],
      dependencies: [],
      appResponseBody: appBody,
    });

    let seenSignature: string | null = null;
    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      secrets: { "payments.webhook.secret": "whsec_test" },
      handler: async (request) => {
        seenSignature = request.headers.get("X-Hub-Signature-256");
        return new Response(appBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(seenSignature).toBe(EXPECTED_INBOUND_HMAC);
    expect(result.signatureOutcomes).toEqual([
      { secretRef: "payments.webhook.secret", ok: true },
    ]);
  });

  it("fails when a required secretRef is missing from local config", async () => {
    const storage = createMemoryStorageProvider();
    const inboundBody = new TextEncoder().encode(
      JSON.stringify({ event: "paid" }),
    );
    const appBody = new TextEncoder().encode(JSON.stringify({ ok: true }));

    const manifest = await persistReplayFixtureWithDeps(storage, {
      inboundMethod: "POST",
      inboundUrl: "https://app.example/webhook",
      inboundBody,
      inboundHeaders: [
        { name: "X-Hub-Signature-256", value: REDACTION_SENTINEL },
      ],
      signatures: [
        {
          target: "inbound.headers.X-Hub-Signature-256",
          algorithm: "hmac-sha256",
          payload: "inbound.body",
          secretRef: "payments.webhook.secret",
          replaced: true,
        },
      ],
      dependencies: [],
      appResponseBody: appBody,
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      handler: async () =>
        new Response(appBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/secret/i);
    expect(result.signatureOutcomes).toHaveLength(1);
    expect(result.signatureOutcomes?.[0]?.secretRef).toBe(
      "payments.webhook.secret",
    );
    expect(result.signatureOutcomes?.[0]?.ok).toBe(false);
    expect(result.signatureOutcomes?.[0]?.message).toMatch(
      /missing|not found/i,
    );
  });

  it("never reads secret material from the Interaction artifact", async () => {
    const storage = createMemoryStorageProvider();
    const inboundBody = new TextEncoder().encode(
      JSON.stringify({ event: "paid" }),
    );
    const appBody = new TextEncoder().encode(JSON.stringify({ ok: true }));

    const manifest = await persistReplayFixtureWithDeps(storage, {
      inboundMethod: "POST",
      inboundUrl: "https://app.example/webhook",
      inboundBody,
      inboundHeaders: [
        {
          name: "X-Hub-Signature-256",
          value: "this-is-not-a-usable-secret-value",
        },
      ],
      signatures: [
        {
          target: "inbound.headers.X-Hub-Signature-256",
          algorithm: "hmac-sha256",
          payload: "inbound.body",
          secretRef: "payments.webhook.secret",
          replaced: true,
        },
      ],
      dependencies: [],
      appResponseBody: appBody,
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      secrets: { "payments.webhook.secret": "whsec_test" },
      handler: async (request) => {
        expect(request.headers.get("X-Hub-Signature-256")).toBe(
          EXPECTED_INBOUND_HMAC,
        );
        return new Response(appBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(result.ok).toBe(true);
  });

  it("regenerates dependency request signature headers from local secrets", async () => {
    const storage = createMemoryStorageProvider();
    const depReqBody = new TextEncoder().encode(
      JSON.stringify({ event: "paid" }),
    );
    const depResBody = new TextEncoder().encode(JSON.stringify({ quote: 1 }));
    const appBody = new TextEncoder().encode(JSON.stringify({ total: 1 }));

    const manifest = await persistReplayFixtureWithDeps(storage, {
      signatures: [
        {
          target: "dependencies[0].request.headers.X-Signature",
          algorithm: "hmac-sha256",
          payload: "dependencies[0].request.body",
          secretRef: "payments.webhook.secret",
          replaced: true,
        },
      ],
      dependencies: [
        {
          seq: 1,
          method: "POST",
          url: "https://api.example/signed",
          requestHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "X-Signature", value: REDACTION_SENTINEL },
          ],
          requestBody: depReqBody,
          responseBody: depResBody,
        },
      ],
      appResponseBody: appBody,
    });

    const result = await runReplay({
      storage,
      interactionId: manifest.id,
      secrets: { "payments.webhook.secret": "whsec_test" },
      handler: async () => {
        const dep = await fetch("https://api.example/signed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: depReqBody,
        });
        const payload = (await dep.json()) as { quote: number };
        return Response.json({ total: payload.quote });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.signatureOutcomes).toEqual([
      { secretRef: "payments.webhook.secret", ok: true },
    ]);
  });
});
