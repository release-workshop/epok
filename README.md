# Epok

Epok makes runtime HTTP behavior portable.

It captures one inbound HTTP execution as an immutable **Interaction** (manifest + content-addressed objects) and replays it later for debugging, testing, and investigation — without needing the original production environment.

## What this repository is

Public, source-available core:

- Interaction artifact contract
- Recorder behavior
- Replay behavior
- Storage Provider seam (local and opaque remote push/pull)

## Packages

| Package                                                     | Responsibility                                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@epok/core`](packages/core/README.md)                     | Shared contracts: **Interaction** manifest shape, **CAS object** references, **Storage Provider** interface. Fetch-shaped / WinterCG-friendly — no Node-only APIs.                        |
| [`@epok/recorder`](packages/recorder/README.md)             | Observes one inbound HTTP execution and its outbound **Dependency** timeline, sanitizes, finalizes an Interaction, and persists via a Storage Provider. Node HTTP attach seam lives here. |
| [`@epok/storage-fs`](packages/storage-fs/README.md)         | Filesystem **Storage Provider** for manifests and CAS objects.                                                                                                                            |
| [`@epok/storage-memory`](packages/storage-memory/README.md) | In-memory **Storage Provider** for tests and local experiments (not durable production persistence).                                                                                      |
| [`@epok/storage-remote`](packages/storage-remote/README.md) | Opaque remote HTTP **Storage Provider** client (explicit endpoint; no default hosted URL).                                                                                                |
| [`@epok/replay`](packages/replay/README.md)                 | Consumes stored Interactions for executable re-run and validation.                                                                                                                        |
| [`@epok/cli`](packages/cli/README.md)                       | CLI (`epok`) over replay run/validate.                                                                                                                                                    |
| [`examples/demo`](examples/demo/README.md)                  | Unpublished in-repo golden-path demo (not published to npm).                                                                                                                              |

## Hosted product

A hosted storage and catalog product for Interactions is available separately. This repository does not include hosted product design, APIs, or client defaults pointing at any commercial endpoint.

## Docs

1. [Quickstart](docs/quickstart.md) — record → persist → replay → validate
2. [Vision & architecture](docs/01-vision-architecture.md)
3. [Recorder](docs/02-recorder-spec.md)
4. [Interaction](docs/03-interaction-spec.md)
5. [Storage Provider](docs/04-storage-provider-spec.md)
6. [Replay](docs/05-replay-spec.md)

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

First-run golden path:

```bash
pnpm --filter @epok/demo golden
```

## License

Source-available under the [Business Source License 1.1](LICENSE). Contributions require a [CLA](CLA.md).
