# Epok demo

Unpublished in-repo example for the record → persist → replay → validate golden path.

## Responsibility

Tiny no-framework Node server that demonstrates `@epok/recorder` observe-only attach (inbound HTTP + outbound `fetch`), then later a filesystem **Storage Provider** and `@epok/replay` / CLI against a real **Interaction**. Not published to npm.

## Status

Observe-only proof: concurrent requests log deterministic inbound + dependency wide events. Persist / sanitize / replay land in later slices.

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @epok/demo start
```

In another terminal, drive concurrent requests:

```bash
for i in $(seq 0 19); do
  curl -s -H "x-request-id: req-$i" "http://127.0.0.1:3456/" &
done
wait
```

Demo stdout should show matching `requestId` values on inbound and dependency `observed` events for each `interactionId`.

## Docs

- Root [README](../../README.md) packages table
- [Recorder](../../docs/02-recorder-spec.md) · [Interaction](../../docs/03-interaction-spec.md) · [Replay](../../docs/05-replay-spec.md)
