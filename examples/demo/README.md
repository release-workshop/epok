# Epok demo

Unpublished in-repo example for the attach → HTTP error path → persist →
replay → validate golden path.

## Quickstart

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @epok/demo golden
```

That starts a standalone Node HTTP server with `attachRecorder` + filesystem
storage, drives `GET /fail` (HTTP 500) so default `captureMode: "errors"`
persists one Interaction under `examples/demo/.epok-data`, then runs
`epok replay validate` and `epok replay run`.

## Manual path (server → curl → CLI)

```bash
pnpm --filter @epok/demo start
```

In another terminal:

```bash
curl -s -H 'x-request-id: demo-1' http://127.0.0.1:3456/fail
```

The server prints an `interaction_persisted` JSON line with the Interaction id
and copy-paste CLI commands. Or substitute the id from
`examples/demo/.epok-data/manifests/`:

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

`GET /total` is the happy path (200) and is **not** persisted under default
`errors` mode — use `/fail` for the record path.

## What it shows

- `attachRecorder` on a no-framework Node `http.Server` (not a hand-built capture harness)
- Filesystem **Storage Provider** (`@epok/storage-fs`) under `.epok-data`
- Default `captureMode: "errors"` — persist only when the inbound response is ≥500
- CLI `epok replay validate` (integrity) and `epok replay run` (injected dependencies)

## Docs

- [Quickstart](../../docs/quickstart.md)
- Root [README](../../README.md)
- [Replay](../../docs/05-replay-spec.md) · [Storage Provider](../../docs/04-storage-provider-spec.md)
