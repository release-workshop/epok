# `@epok/storage-fs`

Filesystem **Storage Provider** for Interaction manifests and **CAS objects**.

## Responsibility

Persist and retrieve sanitized manifests and content-addressed body bytes on the local filesystem. Durable local persistence for the golden path and offline workflows.

## Status

`createFsStorageProvider` is a typed seam stub; implementation lands in the storage-provider slice.

## Install

```bash
pnpm add @epok/storage-fs
```

## Docs

- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- Contract types: [`@epok/core`](../core/README.md)
