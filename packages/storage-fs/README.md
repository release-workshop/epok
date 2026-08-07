# `@epok/storage-fs`

Filesystem **Storage Provider** for Interaction manifests and **CAS objects**.

## Responsibility

Persist and retrieve sanitized manifests and content-addressed body bytes on the local filesystem. Durable local persistence for the golden path and offline workflows.

Layout under `rootDir`:

- `manifests/<id>.json` — sanitized manifest bytes
- `objects/sha256/<hash>` — CAS object bytes

`putManifest` refuses to succeed unless every required CAS object is either embedded in the manifest or already stored.

## Install

```bash
pnpm add @epok/storage-fs
```

## Usage

```ts
import { createFsStorageProvider } from "@epok/storage-fs";

const storage = createFsStorageProvider({ rootDir: "./.epok-data" });
```

## Docs

- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- Contract types: [`@epok/core`](../core/README.md)
