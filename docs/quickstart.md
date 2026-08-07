# Quickstart

Record one HTTP execution as an **Interaction**, persist it on the filesystem, then validate and replay it with the `epok` CLI.

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

1. **Record** — the demo app calls one outbound `fetch`, sanitizes, and writes an Interaction via the filesystem Storage Provider (`examples/demo/.epok-data`)
2. **Validate** — `epok replay validate` checks manifest + CAS closure
3. **Replay** — `epok replay run --handler …` re-drives the app path and injects the recorded dependency response (no live dependency)

## Manual CLI

After `pnpm --filter @epok/demo record`:

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

| Option             | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `--dir <path>`     | Filesystem Storage Provider root (default `.epok`)           |
| `--handler <path>` | ESM module exporting `default` / `handler` / `handleRequest` |
| `--report json`    | Machine-readable `ReplayResult`                              |

## Next reading

- Demo details: [`examples/demo/README.md`](../examples/demo/README.md)
- Replay behavior: [`docs/05-replay-spec.md`](./05-replay-spec.md)
- Packages: root [`README.md`](../README.md)
