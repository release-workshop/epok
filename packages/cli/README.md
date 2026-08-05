# `@epok/cli`

Command-line interface for Epok (`epok` bin).

## Responsibility

Thin ergonomics over `@epok/replay` for local workflows:

- `epok replay run <interaction-ref>` — executable re-run
- `epok replay validate <interaction-ref>` — integrity / compatibility checks

## Status

Command paths are stubbed; wiring lands in the CLI golden-path slice.

## Install

```bash
pnpm add -g @epok/cli
# or from the monorepo after build:
pnpm --filter @epok/cli exec epok
```

## Docs

- [Replay spec](../../docs/05-replay-spec.md) (§10 CLI sketch)
- Library API: [`@epok/replay`](../replay/README.md)
