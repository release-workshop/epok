# Epok

Epok makes runtime HTTP behavior portable.

It captures one inbound HTTP execution as an immutable **Interaction** (manifest + content-addressed objects) and replays it later for debugging, testing, and investigation — without needing the original production environment.

## What this repository is

Public, source-available core:

- Interaction artifact contract
- Recorder behavior
- Replay behavior
- Storage Provider seam (local and opaque remote push/pull)

## Hosted product

A hosted storage and catalog product for Interactions is available separately. This repository does not include hosted product design, APIs, or client defaults pointing at any commercial endpoint.

## Docs

1. [Vision & architecture](docs/01-vision-architecture.md)
2. [Recorder](docs/02-recorder-spec.md)
3. [Interaction](docs/03-interaction-spec.md)
4. [Storage Provider](docs/04-storage-provider-spec.md)
5. [Replay](docs/05-replay-spec.md)

## License

Source-available under the [Business Source License 1.1](LICENSE). Contributions require a [CLA](CLA.md).
