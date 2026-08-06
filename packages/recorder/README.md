# `@epok/recorder`

Records one inbound HTTP execution as an immutable **Interaction**, then persists it through a **Storage Provider**.

## Responsibility

- Attach to the host runtime (Node HTTP attach seam lives here)
- Observe inbound request, outbound **Dependency** calls, and host response
- Sanitize before persist; finalize manifest + **CAS** references
- Hand off asynchronously to a Storage Provider (fail-open for the app)

Core observation contracts stay Fetch-shaped in `@epok/core`. This package adapts Node into those contracts.

## Status

`attachRecorder` installs observe-only Node attach: request-scoped context (`AsyncLocalStorage`), inbound `http.Server` wrapping, outbound `fetch` interception, and wide structured events. Sanitize / finalize / persist land in later spine slices.

## Install

```bash
pnpm add @epok/recorder
```

## Docs

- [Recorder spec](../../docs/02-recorder-spec.md)
- [Interaction spec](../../docs/03-interaction-spec.md)
