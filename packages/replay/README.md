# `@epok/replay`

Consumes stored **Interactions** for executable re-run and validation.

## Responsibility

- Load an Interaction (manifest + **CAS** closure) from a **Storage Provider**
- Executable re-run: re-drive the app path and inject recorded **Dependency** responses
- Validate integrity / compatibility without full re-execution
- MVP defaults: strict matching, instant timing

Matching helpers for method + URL (+ `seq`) live in `@epok/core` and are re-exported here.

## Status

`runReplay` / `validateReplay` are typed seam stubs; implementation lands in the replay spine slice.

## Install

```bash
pnpm add @epok/replay
```

## Docs

- [Replay spec](../../docs/05-replay-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
