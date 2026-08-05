# Epok demo

Unpublished in-repo example for the record → persist → replay → validate golden path.

## Responsibility

Tiny no-framework Node server that demonstrates `@epok/recorder`, a filesystem **Storage Provider**, and `@epok/replay` / CLI against a real **Interaction**. Not published to npm.

## Status

Placeholder HTTP server only. Full golden-path wiring lands in the CLI / example slice.

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @epok/demo start
```

## Docs

- Root [README](../../README.md) packages table
- [Recorder](../../docs/02-recorder-spec.md) · [Interaction](../../docs/03-interaction-spec.md) · [Replay](../../docs/05-replay-spec.md)
