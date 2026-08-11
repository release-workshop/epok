# Cloudflare Workers runtime proof

Epok records Interactions on Cloudflare Workers at the **fetch handler** boundary (inbound `Request` + outbound `fetch` dependencies). Node uses `attachRecorder`; Workers uses `@epok/recorder/workers`.

## Attach

```typescript
import { attachWorkersRecorder } from "@epok/recorder/workers";
import { createMemoryStorageProvider } from "@epok/storage-memory";

const storage = createMemoryStorageProvider();
const recorder = attachWorkersRecorder({ storage, captureMode: "full" });

export default {
  fetch: recorder.wrapHandler(async (request: Request) => {
    const dep = await fetch("https://api.example/quote");
    const payload = await dep.json();
    return Response.json({ total: payload.quote });
  }),
};
```

### Runtime requirements

- **Request context:** enable `nodejs_als` (or broader Node.js compatibility) so `AsyncLocalStorage` binds outbound `fetch` to the inbound handler.
- **Finalize/persist on Workers today:** `@epok/recorder/workers` shares the Node recorder finalize path (`node:crypto`, `Buffer`) — enable **`nodejs_compat`** on the Worker until finalize is migrated to portable Web Crypto. Vitest proves the Fetch-handler attach + persist + offline replay path on Node; deploy-time Workers smoke is a follow-on (no Workers CI in MVP).
- **Storage:** use `@epok/storage-memory` for in-isolate proofs, or `@epok/storage-remote` with an explicit endpoint for durable persistence. Filesystem storage is Node-only.
- **`@epok/core`** stays free of Node-only imports; Workers-specific attach lives in `@epok/recorder/workers`.

## Offline executable replay (Workers-equivalent path)

Workers record → persist via a Storage Provider → **replay on Node** with the same Fetch-shaped handler:

```bash
# After exporting the Interaction to a filesystem store (or using in-memory in tests):
pnpm --filter @epok/cli exec epok replay validate --dir ./.epok-data <interaction-id>
pnpm --filter @epok/cli exec epok replay run \
  --dir ./.epok-data \
  --handler ./dist/handler.js \
  <interaction-id>
```

Programmatic replay uses `@epok/replay` `runReplay` with a `ReplayHandler` (`(request: Request) => Response | Promise<Response>`). Dependency responses are injected from the recorded Interaction — no live network during replay.

Vitest proof: `packages/recorder/tests/workers-golden-replay.test.ts`.

## Related

- Build plan: `.scratch/oss-mvp/build-plan.md` (Workers first after Node)
- Node interception research: `.scratch/oss-mvp/research/node-interception.md`
- Recorder spec: `docs/02-recorder-spec.md` §5.3
