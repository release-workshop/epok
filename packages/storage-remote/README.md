# `@epok/storage-remote`

Opaque remote HTTP **Storage Provider** client for Interaction manifests and **CAS objects**.

## Responsibility

Same Storage Provider seam as `@epok/storage-fs` / `@epok/storage-memory`, speaking persistence-only HTTP(S) against an **explicitly configured** base URL. Caller supplies the endpoint (and any auth headers). This package embeds **no default** commercial or product hostname.

Transport covers put/get/exists for manifests and CAS objects only — not hosted-product surfaces (workspaces, catalogs, notifications, and similar).

## Wire protocol

Relative to the configured `endpoint` (path prefixes on the endpoint are preserved):

| Method | Path                 | Notes                                                                        |
| ------ | -------------------- | ---------------------------------------------------------------------------- |
| `PUT`  | `manifests/:id`      | Body = manifest bytes; headers `x-epok-spec-version`, `x-epok-manifest-hash` |
| `GET`  | `manifests/:id`      | Returns manifest bytes                                                       |
| `PUT`  | `objects/:alg/:hash` | Body = CAS bytes; JSON `{ "created": boolean }` preferred                    |
| `GET`  | `objects/:alg/:hash` | Returns CAS bytes                                                            |
| `HEAD` | `objects/:alg/:hash` | `200` if present, `404` if missing                                           |

Typed failures may be signaled with HTTP status and/or `x-epok-storage-error` (`unavailable` \| `timeout` \| `quota` \| `integrity` \| `not_found` \| `unauthorized`).

`putManifest` still refuses locally unless every required CAS object is embedded or already present at the remote (`HEAD`).

## Install

```bash
pnpm add @epok/storage-remote
```

## Usage

```ts
import { createRemoteStorageProvider } from "@epok/storage-remote";

const storage = createRemoteStorageProvider({
  endpoint: process.env.EPOK_STORAGE_URL!, // operator-configured; no package default
  headers: {
    Authorization: `Bearer ${process.env.EPOK_STORAGE_TOKEN}`,
  },
});
```

## Docs

- [Storage Provider spec](../../docs/04-storage-provider-spec.md)
- Contract types: [`@epok/core`](../core/README.md)
