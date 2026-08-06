# `@epok/core`

Shared contracts for Epok’s public core. Fetch-shaped / WinterCG-friendly — no Node-only APIs.

## Responsibility

- **Interaction** manifest types (inbound request, **Dependency** timeline, host response, integrity)
- **CAS object** references and embed threshold helpers
- **Storage Provider** interface and typed `StorageError`
- Strict replay request matching (`method` + URL, optional `seq`)
- Observation hooks using Fetch `Request` / `Response`
- Epok-owned minimal **sanitizer** ruleset + extension point (header/query/JSON-form redaction)

## Install

```bash
pnpm add @epok/core
```

## Docs

- [Interaction spec](../../docs/03-interaction-spec.md)
- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- [Replay spec](../../docs/05-replay-spec.md)
- [Domain glossary](../../CONTEXT.md)
