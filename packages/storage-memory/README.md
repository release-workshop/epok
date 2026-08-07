# `@epok/storage-memory`

In-memory **Storage Provider** for Interaction manifests and **CAS objects**.

## Responsibility

Same Storage Provider seam as `@epok/storage-fs`, backed by process memory. Intended for tests and local experiments.

**Not durable. Not for production persistence.** Data lives only in the current process and is lost on exit. Use `@epok/storage-fs` (or a remote provider) when Interactions must survive process restart.

`putManifest` refuses to succeed unless every required CAS object is either embedded in the manifest or already stored.

## Install

```bash
pnpm add @epok/storage-memory
```

## Usage

```ts
import { createMemoryStorageProvider } from "@epok/storage-memory";

const storage = createMemoryStorageProvider();
```

## Docs

- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- Contract types: [`@epok/core`](../core/README.md)
