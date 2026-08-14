import { describe, expect, it } from "vitest";
import {
  observeDependency,
  observeInbound,
  observeResponse,
} from "../src/observe.js";
import { createCaptureContext } from "../src/context.js";
import type { RecorderWideEvent } from "../src/events.js";

describe("observation", () => {
  it("calls Fetch-shaped hooks and does not emit wide observed events", () => {
    const ctx = createCaptureContext(false);
    const events: RecorderWideEvent[] = [];
    const inbound: Request[] = [];
    const responses: Response[] = [];
    const dependencies: Array<{
      request: Request;
      response: Response | null;
    }> = [];

    observeInbound(
      ctx,
      new Request("http://app.test/in"),
      { onInbound: (request) => inbound.push(request) },
      (event) => {
        events.push(event);
      },
    );
    observeResponse(
      ctx,
      new Response(null, { status: 204 }),
      { onResponse: (response) => responses.push(response) },
      (event) => {
        events.push(event);
      },
    );
    const depResponse = new Response("ok", { status: 200 });
    observeDependency(
      ctx,
      "http://api.test/dep",
      { method: "GET" },
      depResponse,
      {
        onDependency: (request, response) => {
          dependencies.push({ request, response });
        },
      },
      (event) => {
        events.push(event);
      },
    );

    expect(inbound[0]?.url).toBe("http://app.test/in");
    expect(responses[0]?.status).toBe(204);
    expect(dependencies[0]?.request.url).toContain("http://api.test/dep");
    expect(dependencies[0]?.response?.status).toBe(200);
    expect(events).toEqual([]);
  });

  it("emits context_missing onEvent when fetch has no Interaction context", () => {
    const events: RecorderWideEvent[] = [];
    observeDependency(
      undefined,
      "http://api.test/outside",
      undefined,
      null,
      undefined,
      (event) => {
        events.push(event);
      },
    );
    expect(events[0]?.type).toBe("context_missing");
    if (events[0]?.type === "context_missing") {
      expect(events[0].reason).toBe("no_request_context");
      expect(events[0].method).toBe("GET");
      expect(events[0].url).toContain("http://api.test/outside");
    }
  });

  it("records observation_dropped when a hook throws and does not rethrow", () => {
    const ctx = createCaptureContext(false);
    const events: RecorderWideEvent[] = [];
    observeInbound(
      ctx,
      new Request("http://app.test/in"),
      {
        onInbound() {
          throw new Error("hook boom");
        },
      },
      (event) => {
        events.push(event);
      },
    );
    expect(
      events.some(
        (e) =>
          e.type === "observation_dropped" && e.reason === "observer_threw",
      ),
    ).toBe(true);
  });
});
