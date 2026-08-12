# `@epok/recorder`

Records one inbound HTTP execution as an immutable **Interaction**, then persists it through a **Storage Provider**.

## Responsibility

- Attach to the host runtime (Node HTTP attach seam lives here)
- Observe inbound request, outbound **Dependency** calls, and host response
- Sanitize before persist; finalize manifest + **CAS** references
- Hand off asynchronously to a Storage Provider (fail-open for the app)
- Bound background queues and shed Interactions deterministically under pressure

Core observation contracts stay Fetch-shaped in `@epok/core`. This package adapts Node into those contracts.

## Status

`attachRecorder` installs Node attach (request-scoped context, inbound `http.Server` wrap, outbound `fetch` intercept) and enqueues sanitize → finalize → persist on a bounded async queue. For Fetch-shaped runtimes: Cloudflare Workers → `@epok/recorder/workers` ([proof](../../docs/workers-runtime-proof.md)); Bun → `@epok/recorder/bun` ([proof](../../docs/bun-runtime-proof.md)). `enabled: false` keeps interception plumbing installed while short-circuiting capture/sanitize/persist (structural no-op baseline). When queue/context/buffer budgets are exceeded, the recorder sheds deterministically (never the host request). Byte-budget pressure **elides bodies** by default (`pressure.bodyElision`, default `true`) and still persists a valid Interaction with empty CAS bodies; set `bodyElision: false` to drop instead (`buffered_bytes_budget`). Queue and active-context pressure still drop the Interaction. Wide events cover observed/finalized/persisted/dropped, queue depth, shedding activation, and `body_elided`.

## Capture intensity (`captureMode`)

Collect stays always-on when the recorder is enabled. Persist intensity is controlled by `captureMode`:

| Mode       | Default? | Sanitize → finalize → persist                              |
| ---------- | -------- | ---------------------------------------------------------- |
| `"errors"` | **yes**  | Only inbound status **≥ 500** or a terminal host exception |
| `"full"`   | opt-in   | Every completed Interaction                                |

Non-persist under `errors` emits `interaction_dropped` with reason `capture_mode_filter` (not a pressure shed). Pressure budgets and shedding are unchanged and take precedence when over budget. `enabled: false` remains orthogonal (credibility structural no-op).

Production default is `"errors"` for lean storage. Use `"full"` for test-data collection. The credibility B harness **always pins `captureMode: "full"`** (worst case); pass `--capture-mode errors` only for headroom compare experiments, never as the CI gate profile.

## Self-observation

Poll `stats()` on the recorder handle for health and shedding — no subscriber required. The snapshot includes lifecycle counters (`observed`, `finalized`, `persisted`, `dropped`, `filtered`, `elided`) and point-in-time gauges (`queueDepth`, `activeContexts`, `bufferedBytes`, shed flags). Derive shed rate as `dropped / observed`.

Wide events via `onEvent` remain opt-in for harnesses and debugging. When set, `onEventCategories` defaults to `"pressure"` (queue/shed/drop/elide/finalize/persist/`observation_dropped`) so subscribers are not flooded with per-request `observed` chatter; pass `"all"` to include `observed` and `context_missing`. With no `onEvent`, the recorder skips wide-event emit work entirely — counters still update via `stats()`. Exporters do **not** need `onEvent` (or `"all"` event verbosity). `pressureStats()` is a deprecated alias of `stats()`.

### Metrics exporter (opt-in)

`startStatsExporter` periodically polls `stats()` and pushes absolute snapshots plus **counter deltas** to your sink. No Prometheus/OTel dependency in public core — wire `onSample` to logs, a dashboard agent, or your own metrics client. The timer is unref'd and fail-open (`onSample` throws are swallowed).

```ts
import { attachRecorder, startStatsExporter } from "@epok/recorder";

const handle = attachRecorder({ storage });
const exporter = startStatsExporter({
  stats: () => handle.stats(),
  intervalMs: 10_000,
  onSample: ({ at, snapshot, deltas }) => {
    console.log(JSON.stringify({ at, snapshot, deltas }));
  },
});

// later
exporter.stop();
handle.detach();
```

Wide-event subscription stays independent: you can use `onEvent` without exporters, and exporters without any subscriber.

## Pressure controls

Optional `pressure` bounds on `attachRecorder`:

| Limit               | Default | Effect when exceeded                                   |
| ------------------- | ------- | ------------------------------------------------------ |
| `maxQueueDepth`     | 128     | Drop at enqueue (`queue_full`)                         |
| `maxConcurrency`    | 2       | Caps parallel finalize/persist workers                 |
| `maxActiveContexts` | 256     | Drop at request start (`active_contexts_budget`)       |
| `maxBufferedBytes`  | 16 MiB  | Elide bodies (`body_elided`); persist metadata         |
| `bodyElision`       | `true`  | `false` drops on byte budget (`buffered_bytes_budget`) |

`stats()` exposes `elided` (body-elision activations) and `byteBudgetExhausted` alongside `dropped`/`observed`/`filtered`. Byte-budget shedding emits `body_elided` (with `interactionId` when known); queue/context shedding emits `shedding` + `interaction_dropped`. Body elision does **not** enter full shed mode (collect continues; only payloads are stripped).

Local overload proof:

```bash
pnpm --filter @epok/recorder stress:shed
```

## Production-credibility bar (B)

Benchmark harness compares `enabled: false` (structural no-op) vs `enabled: true` on S1/S2 dependency-latency scenarios at concurrency `[50, 100]`.

```bash
# Pre-merge profile (10s warmup + 30s measure, enforces B, reports A)
# Defaults to --capture-mode full (worst-case gate; do not use errors for CI B)
pnpm --filter @epok/recorder credibility:b -- --profile premerge --out credibility-b.json

# Post-merge profile (10s warmup + 120s measure)
pnpm --filter @epok/recorder credibility:b -- --profile postmerge --out credibility-b-postmerge.json
```

Machine-readable JSON includes per-cell trials, B gate (blocking), and A report (non-blocking until promotion).

### Headroom baseline + before/after compare

Frozen premerge headroom benchmark: `harness/baselines/credibility-b-headroom.json` (S1/S2 × `[50,100]`, 10s warmup / 30s measure, 3 trials). Later headroom issues must attach machine-readable before/after compare evidence against this file — do not argue from vibes.

```bash
# Re-run the same premerge profile
pnpm --filter @epok/recorder credibility:b -- --profile premerge --out credibility-b-after.json

# Cell-by-cell deltas (median trial B/A p50/p99/throughput) + protocol pass/fail
pnpm --filter @epok/recorder credibility:b -- \
  --compare harness/baselines/credibility-b-headroom.json credibility-b-after.json \
  --out credibility-b-compare.json
```

Compare output type is `credibility_b_compare`. `matched` means cell set + protocol metadata (`profile` / warmup / measure / trials) align — not B/A variance success. Cite `cells[].deltas` (candidate − baseline for p50/p99 increases and throughput ratio) and `cells[].protocol` (`candidateOk` / `candidatePasses` / `candidateTrials`). Negative `deltas.b.p50Increase` / `p99Increase` and positive `deltas.b.throughputRatio` mean improvement vs the frozen baseline. Thresholds are unchanged; A remains non-blocking.

## Install

```bash
pnpm add @epok/recorder
```

## Docs

- [Recorder spec](../../docs/02-recorder-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
