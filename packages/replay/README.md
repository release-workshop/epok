# `@epok/replay`

Consumes stored **Interactions** for executable re-run and validation.

## Responsibility

- Load an Interaction (manifest + **CAS** closure) from a **Storage Provider**
- Executable re-run: re-drive the app path and inject recorded **Dependency** responses
- Validate integrity / compatibility without full re-execution
- MVP defaults: strict matching, instant timing

Matching helpers for method + URL (+ `seq`) live in `@epok/core` and are re-exported here.

## Usage

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
```

`ReplayResult` includes optional `timingNotes` / `signatureOutcomes` slots so later timing and signature enrichment can land without reshaping the report type.

## Install

```bash
pnpm add @epok/replay
```

## Docs

- [Replay spec](../../docs/05-replay-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
