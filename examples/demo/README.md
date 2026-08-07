# Epok demo

Unpublished in-repo example for the record → persist → replay → validate golden path.

## Quickstart

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @epok/demo golden
```

That records one Interaction to `examples/demo/.epok-data`, validates CAS closure, then executable-replays with dependency injection (no external network on replay).

## Step by step

```bash
pnpm --filter @epok/demo record
```

Follow the printed commands, or substitute the printed `interactionId`:

```bash
pnpm --filter @epok/cli exec epok replay validate \
  --dir examples/demo/.epok-data \
  <interaction-id>

pnpm --filter @epok/cli exec epok replay run \
  --dir examples/demo/.epok-data \
  --handler examples/demo/dist/handler.js \
  <interaction-id>
```

PASS / FAIL lines are printed on stdout (PASS) or stderr (FAIL). Add `--report json` for machine-readable output.

## What it shows

- Filesystem **Storage Provider** (`@epok/storage-fs`) under `.epok-data`
- Sanitize + finalize via `@epok/recorder`
- CLI `epok replay validate` (integrity) and `epok replay run` (injected dependencies)

## Optional long-running server

```bash
pnpm --filter @epok/demo start
curl -s -H "x-request-id: req-1" http://127.0.0.1:3456/
```

Observe-only attach logs inbound + dependency pairs. Prefer `golden` for the full persist/replay proof.

## Docs

- [Quickstart](../../docs/quickstart.md)
- Root [README](../../README.md)
- [Replay](../../docs/05-replay-spec.md) · [Storage Provider](../../docs/04-storage-provider-spec.md)
