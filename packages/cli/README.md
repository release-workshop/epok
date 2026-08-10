# `@epok/cli`

Command-line interface for Epok (`epok` bin).

## Responsibility

Thin ergonomics over `@epok/replay` for local workflows:

- `epok replay run <interaction-id>` — executable re-run with a handler module
- `epok replay mock <interaction-id>` — snapshot/mock fixtures (no handler / no re-drive)
- `epok replay validate <interaction-id>` — integrity / compatibility checks

## Usage

```bash
epok replay validate --dir .epok-data <interaction-id>
epok replay run --dir .epok-data --handler ./handler.js <interaction-id>
epok replay mock --dir .epok-data <interaction-id>
```

`run` is executable re-run (re-drives the handler and compares the response).
`mock` loads snapshot fixtures from the Interaction (no handler / no re-drive).
Use `mockReplay().installFetch()` in library code to stub dependencies.

Options:

- `--dir <path>` — filesystem Storage Provider root (default: `.epok`)
- `--handler <path>` — required for `run`; ESM export `default`, `handler`, or `handleRequest`
- `--report text|json` — text (default) or JSON `ReplayResult`
- `--mode strict|diagnostic-lenient` — mismatch policy (`strict` fail-fast default; `diagnostic-lenient` continues after safe soft mismatches and never claims deterministic success when deviations occurred)
- `--timing instant|realtime` — dependency pacing (`instant` default; `realtime` approximates recorded durations / relative `endedAt`)

Exit codes: `0` pass, `1` fail/mismatch, `2` usage error.

Text output examples:

```text
PASS  0190…
      Interaction integrity and compatibility checks passed

FAIL  0190…
      no recorded dependency matches GET https://api.example/wrong-path
      - dependency_mismatch: …  method=GET  url=https://api.example/wrong-path
```

## Install

```bash
pnpm add -g @epok/cli
# or from the monorepo after build:
pnpm --filter @epok/cli exec epok replay --help
```

## Docs

- [Quickstart](../../docs/quickstart.md)
- [Replay spec](../../docs/05-replay-spec.md) (§10 CLI sketch)
- Library API: [`@epok/replay`](../replay/README.md)
