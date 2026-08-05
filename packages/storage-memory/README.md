# `@epok/storage-memory`

In-memory **Storage Provider** for Interaction manifests and **CAS objects**.

## Responsibility

Same Storage Provider seam as `@epok/storage-fs`, backed by process memory. Intended for tests and local experiments.

**Not durable.** Do not use as production persistence.

## Status

`createMemoryStorageProvider` is a typed seam stub; implementation lands in the storage-provider slice.

## Install

```bash
pnpm add @epok/storage-memory
```

## Docs

- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- Contract types: [`@epok/core`](../core/README.md)
