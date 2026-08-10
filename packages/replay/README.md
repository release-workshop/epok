# `@epok/replay`

Consumes stored **Interactions** for executable re-run, snapshot/mock fixtures, and validation.

## Responsibility

- Load an Interaction (manifest + **CAS** closure) from a **Storage Provider**
- Executable re-run: re-drive the app path and inject recorded **Dependency** responses
- Snapshot/mock: serve the same artifacts as fixtures **without** executable re-drive
- Validate integrity / compatibility without full re-execution
- Defaults: strict matching, instant timing

Matching helpers live in `@epok/core` (`matchDependency` for executable; `matchSnapshotDependency` for snapshot).

## Modes

| Mode                            | API                      | What it does                                                                                                                                    |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Executable re-run** (primary) | `runReplay({ handler })` | Re-drives the inbound request through your handler, injects deps (method+URL+seq), compares the app response to the recorded Interaction        |
| **Snapshot/mock** (secondary)   | `mockReplay()`           | Materializes inbound + recorded response fixtures; `installFetch()` stubs deps with hybrid signature matching — no handler, no response compare |

Both modes consume the same Interaction artifact. Choose explicitly: do not treat snapshot success as executable verification.

## Usage

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

`ReplayResult` includes optional `timingNotes` / `signatureOutcomes` slots so later timing and signature enrichment can land without reshaping the report type.

## Install

```bash
pnpm add @epok/replay
```

## Docs

- [Replay spec](../../docs/05-replay-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
