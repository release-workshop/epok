# Bun runtime proof

Epok records Interactions on **Bun** at the Fetch handler boundary (`Bun.serve` inbound `Request` + outbound `fetch` dependencies). Node uses `attachRecorder`; Bun uses `@epok/recorder/bun`.

## Attach

```typescript
import { attachBunRecorder } from "@epok/recorder/bun";
import { createMemoryStorageProvider } from "@epok/storage-memory";

const storage = createMemoryStorageProvider();
const recorder = attachBunRecorder({ storage, captureMode: "full" });

Bun.serve({
  fetch: recorder.wrapHandler(async (request: Request) => {
    const dep = await fetch("https://api.example/quote");
    const payload = await dep.json();
    return Response.json({ total: payload.quote });
  }),
});
```

### Runtime notes

- **Request context:** Bun provides `AsyncLocalStorage` natively — no compatibility flags required (unlike Cloudflare Workers `nodejs_als`).
- **Shared attach path:** `@epok/recorder/bun` is a thin wrapper over `@epok/recorder/workers` with `runtime.name: "bun"`. Fetch-shaped capture, sanitize, finalize, and persist behave the same as Workers.
- **Storage:** use `@epok/storage-memory` for in-process proofs, or `@epok/storage-remote` with an explicit endpoint for durable persistence. Filesystem storage is Node-only.
- **`@epok/core`** stays free of Node-only imports; Bun-specific attach lives in `@epok/recorder/bun`.

## Offline executable replay (Bun-equivalent path)

Bun record → persist via a Storage Provider → **replay on Node** with the same Fetch-shaped handler:

```bash
pnpm --filter @epok/cli exec epok replay validate --dir ./.epok-data <interaction-id>
pnpm --filter @epok/cli exec epok replay run \
  --dir ./.epok-data \
  --handler ./dist/handler.js \
  <interaction-id>
```

Programmatic replay uses `@epok/replay` `runReplay` with a `ReplayHandler` (`(request: Request) => Response | Promise<Response>`). Dependency responses are injected from the recorded Interaction — no live network during replay.

## Tests

| Proof                                          | Command                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Attach + offline golden replay (Vitest / Node) | `pnpm test packages/recorder/tests/bun-attach.test.ts packages/recorder/tests/bun-golden-replay.test.ts` |
| Bun.serve runtime smoke                        | `pnpm --filter @epok/recorder test:bun` (requires [Bun](https://bun.sh) installed)                       |

Vitest proves the Fetch-handler attach + persist + offline replay path on Node (same strategy as [Workers runtime proof](./workers-runtime-proof.md)). The `test:bun` script adds a Bun.serve smoke test when Bun is available locally.

## Related

- Build plan: `.scratch/oss-mvp/build-plan.md` (Bun after Workers)
- Workers proof: [Workers runtime proof](./workers-runtime-proof.md)
- Recorder spec: `docs/02-recorder-spec.md` §5.3
