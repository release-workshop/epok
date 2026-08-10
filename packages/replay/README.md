# `@epok/replay`

Consumes stored **Interactions** for executable re-run, snapshot/mock fixtures, and validation.

## Responsibility

- Load an Interaction (manifest + **CAS** closure) from a **Storage Provider**
- Executable re-run: re-drive the app path and inject recorded **Dependency** responses
- Snapshot/mock: serve the same artifacts as fixtures **without** executable re-drive
- Validate integrity / compatibility without full re-execution
- Defaults: strict matching (fail-fast), instant timing; `diagnostic-lenient` selectable for investigation; `realtime` timing paces dependency completion from recorded timings

Matching helpers live in `@epok/core` (`matchDependency` for executable; `matchSnapshotDependency` for snapshot). Executable matching stays MVP-compatible (unique method+URL), and uses selected non-secret headers + body hash to disambiguate identical method+URL rows. Auth/cookie headers and redacted values are never match material; redacted query values are ignored when comparing URLs.

## Modes

| Mode                            | API                      | What it does                                                                                                                                                               |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Executable re-run** (primary) | `runReplay({ handler })` | Re-drives the inbound request through your handler, injects deps (method+URL, richer signature disambiguation, seq), compares the app response to the recorded Interaction |
| **Snapshot/mock** (secondary)   | `mockReplay()`           | Materializes inbound + recorded response fixtures; `installFetch()` stubs deps with hybrid signature matching — no handler, no response compare                            |

Both modes consume the same Interaction artifact. Choose explicitly: do not treat snapshot success as executable verification.

### Timing (`timing`)

| Mode                    | Behavior                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`instant`** (default) | Deliver dependency responses as soon as matching succeeds.                                                                                                                                              |
| **`realtime`**          | Best-effort pacing: never complete earlier than recorded duration (`endedAt - startedAt`) from the live fetch, or earlier than recorded `endedAt` from replay start. Drift may appear in `timingNotes`. |

```ts
const result = await runReplay({
  storage,
  interactionId,
  handler,
  timing: "realtime",
});
// result.timing === "realtime"
```

### Mismatch policy (`mode`)

| Policy                   | Behavior                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`strict`** (default)   | Fail-fast on first terminal mismatch (dependency miss, response status/body). Deterministic success only when everything matches.                                                                                                                         |
| **`diagnostic-lenient`** | Investigation only (executable re-run): relax dependency URL to same-method unused row when strict miss; collect response status **and** body mismatches; never `ok: true` if any deviation/relaxation occurred. Snapshot/`mockReplay` stays strict-only. |

```ts
const result = await runReplay({
  storage,
  interactionId,
  handler,
  mode: "diagnostic-lenient",
});
// result.ok === false whenever mismatches were recorded
```

### Signature regeneration (`secrets`)

When an Interaction carries `replay.signatures[]`, replay regenerates those fields from **local** secrets before the handler / fixtures run (RFC §7). Secrets are never read from the artifact.

Supported in v1:

- Algorithms: `hmac-sha256` (hex digest)
- Payload paths: `inbound.body`, `dependencies[N].request.body`
- Target paths: `inbound.headers.<Name>`, `dependencies[N].request.headers.<Name>`

```ts
const result = await runReplay({
  storage,
  interactionId,
  handler,
  secrets: { "payments.webhook.secret": process.env.WEBHOOK_SECRET! },
});
// result.signatureOutcomes — ok/fail per secretRef (no secret material)
```

CLI: `--secret ref=value` (repeatable).

`ReplayResult` may include `timingNotes` when realtime pacing drifts, and `signatureOutcomes` when signature regeneration ran.

### Executable re-run

```ts
import { runReplay, validateReplay } from "@epok/replay";

const validated = await validateReplay({ storage, interactionId });

const result = await runReplay({
  storage,
  interactionId,
  handler: async (request) => {
    // Your app path — outbound fetch is satisfied from the Interaction.
    const dep = await fetch("https://api.example/quote");
    // ...
    return new Response(/* … */);
  },
});
// result.playback === "executable"
```

### Snapshot/mock

```ts
import { mockReplay } from "@epok/replay";

const ready = await mockReplay({ storage, interactionId });
if (!ready.ok) throw new Error(ready.message);

// Fixtures without re-driving the app:
ready.inbound;
ready.recordedResponse;

const injection = ready.installFetch();
try {
  const dep = await fetch("https://api.example/quote");
  // …
} finally {
  injection.restore();
}
// ready.playback === "snapshot"
```

## Install

```bash
pnpm add @epok/replay
```

## Docs

- [Replay spec](../../docs/05-replay-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
