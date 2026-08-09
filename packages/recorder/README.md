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

`attachRecorder` installs Node attach (request-scoped context, inbound `http.Server` wrap, outbound `fetch` intercept) and enqueues sanitize → finalize → persist on a bounded async queue. `enabled: false` keeps interception plumbing installed while short-circuiting capture/sanitize/persist (structural no-op baseline). When queue/context/buffer budgets are exceeded, Interactions are dropped (never the host request). Wide events cover observed/finalized/persisted/dropped, queue depth, and shedding activation.

## Pressure controls

Optional `pressure` bounds on `attachRecorder`:

| Limit               | Default | Effect when exceeded                             |
| ------------------- | ------- | ------------------------------------------------ |
| `maxQueueDepth`     | 128     | Drop at enqueue (`queue_full`)                   |
| `maxConcurrency`    | 2       | Caps parallel finalize/persist workers           |
| `maxActiveContexts` | 256     | Drop at request start (`active_contexts_budget`) |
| `maxBufferedBytes`  | 16 MiB  | Drop capture (`buffered_bytes_budget`)           |

Local overload proof:

```bash
pnpm --filter @epok/recorder stress:shed
```

## Production-credibility bar (B)

Benchmark harness compares `enabled: false` (structural no-op) vs `enabled: true` on S1/S2 dependency-latency scenarios at concurrency `[50, 100]`.

```bash
# Pre-merge profile (10s warmup + 30s measure, enforces B, reports A)
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
