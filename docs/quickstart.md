# Quickstart

Start a standalone Node HTTP demo with the recorder attached, drive an error
path so one Interaction is persisted, then validate and executable-replay it
with the `epok` CLI.

## Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io) 10+

## Golden path (few commands)

```bash
pnpm install
pnpm build
pnpm --filter @epok/demo golden
```

Expected ending:

```text
PASS  <interaction-id>
      Interaction integrity and compatibility checks passed
PASS  <interaction-id>
      replay matched recorded Interaction
{"type":"golden_ok", ...}
```

On mismatch, the CLI prints `FAIL` with an actionable code (for example `dependency_mismatch`) and exits `1`.

## What just happened

1. **Start + request** — the demo starts a no-framework Node HTTP server with `attachRecorder` and the filesystem Storage Provider, then `GET /fail` (spoofed application error → HTTP 500). Default `captureMode: "errors"` persists that Interaction under `examples/demo/.epok-data`
2. **Validate** — `epok replay validate` checks manifest + CAS closure
3. **Replay** — `epok replay run --handler …` re-drives the app path and injects the recorded dependency response (no live dependency)

For fixture-only workflows (no handler re-drive), load snapshot fixtures:

```bash
pnpm --filter @epok/cli exec epok replay mock \
  --dir examples/demo/.epok-data \
  <interaction-id>
```

`run` verifies executable re-run. `mock` confirms snapshot fixtures load from the same Interaction (dependency stubbing is via `mockReplay().installFetch()` in library code).

## Manual path (server → curl → CLI)

```bash
pnpm --filter @epok/demo start
# in another terminal:
curl -s -H 'x-request-id: demo-1' http://127.0.0.1:3456/fail
```

The demo server prints an `interaction_persisted` line with the Interaction id
and the next CLI commands. Then:

```bash
pnpm --filter @epok/cli exec epok replay validate \
  --dir examples/demo/.epok-data \
  <interaction-id>

pnpm --filter @epok/cli exec epok replay run \
  --dir examples/demo/.epok-data \
  --handler examples/demo/dist/handler.js \
  <interaction-id>
```

Useful options:

| Option                      | Meaning                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--dir <path>`              | Filesystem Storage Provider root (default `.epok`)                                                          |
| `--handler <path>`          | ESM module exporting `default` / `handler` / `handleRequest`                                                |
| `--report json`             | Machine-readable `ReplayResult`                                                                             |
| `--mode strict`             | Fail-fast mismatch policy (default)                                                                         |
| `--mode diagnostic-lenient` | Investigation: soft dependency URL match + collect response mismatches; never PASS when deviations occurred |

## Next reading

- Demo details: [`examples/demo/README.md`](../examples/demo/README.md)
- Replay behavior: [`docs/05-replay-spec.md`](./05-replay-spec.md)
- Packages: root [`README.md`](../README.md)
