# Epok

## Recorder Specification

**Document Version:** 1.0.0 (Draft)

**Status:** Engineering RFC

**Audience:** Runtime engineers, platform engineers, recorder contributors

---

## 1. Purpose

The recorder observes one inbound HTTP execution, builds one canonical Interaction artifact, sanitizes all persisted bytes, and hands the finalized artifact to a Storage Provider.

The recorder is passive infrastructure inside the host runtime. It must not participate in business logic or alter application-visible behavior.

This document defines recorder behavior. The artifact contract lives in `docs/03-interaction-spec.md`, replay behavior in `docs/05-replay-spec.md`, and Storage Provider contract in `docs/04-storage-provider-spec.md`.

---

## 2. Scope and Boundaries

### In scope

- HTTP inbound request capture (`Request` -> `Response`) where one inbound request maps to one Interaction.
- Outbound dependency capture for `fetch` executed within the request context.
- Sanitization, finalization, and asynchronous persistence through the Storage Provider seam.
- Runtime adapters for supported frameworks/runtimes.

### Out of scope

- Non-HTTP primary entrypoints (queue triggers, cron triggers, WebSocket-primary sessions).
- Framework-specific plugin contracts beyond the extension surface this RFC names.
- Hosted-product upload API design, authentication/token models, and catalog features.
- Replay engine internals.

---

## 3. Core Operational Guarantees

Recorder implementations MUST preserve these guarantees:

1. **Fail-open for the application:** recorder failures never fail, delay, or mutate app responses.
2. **Sanitize before persist:** unsanitized bytes are never persisted or transmitted.
3. **Immutable finalized artifacts:** once finalized, the manifest and referenced CAS bytes are immutable.
4. **Bounded resources:** memory/queue usage is bounded with deterministic shedding/drop behavior.
5. **Asynchronous persistence:** app request completion never waits on storage completion.
6. **Artifact compatibility:** recorder output conforms to `docs/03-interaction-spec.md`.

---

## 4. Request Lifecycle and State Machine

Each inbound HTTP request owns exactly one Interaction lifecycle:

1. **Create context** at request start (`id` allocated, request-scoped recorder state created).
2. **Collect** inbound request details plus outbound dependency observations.
3. **Complete** when the host response reaches terminal state (or terminal request error is observed).
4. **Sanitize** all bytes destined for manifest/CAS.
5. **Finalize** manifest + integrity fields according to Interaction spec.
6. **Persist** via Storage Provider asynchronously.

Before finalization, the in-memory Interaction may be mutable. After finalization it is immutable.

Partial or aborted executions may still produce persisted Interactions if sanitization and integrity invariants hold; classification is encoded in metadata, not by changing format rules.

---

## 5. Interception Contract

### 5.1 Inbound interception

The recorder wraps inbound request handling to observe:

- protocol, method, URL, headers, body
- response status, headers, body
- request/response timing boundaries

The wrapper observes and records. It must not mutate inbound request contents before app code reads them, and must not mutate outbound response semantics seen by the client.

### 5.2 Outbound interception

Within request context, the recorder instruments `fetch` to capture dependency request/response rows compatible with `dependencies[]` in the Interaction spec.

At minimum each dependency row captures:

- sequence identity (`seq`) and timing (`startedAt`, `endedAt`)
- request message and response message (or structured terminal error)
- retry attempts as distinct rows

### 5.3 Framework plugin surface

Framework integrations (for example Express, Hono, Next.js, Workers adapters) are an extension surface for attaching the same inbound/outbound interception contract.

This RFC does not define framework-specific plugin APIs. It defines only the behavior those plugins must preserve.

---

## 6. Request Context Propagation

Dependency events must be associated with the correct inbound request using request-scoped async context primitives (for example AsyncLocalStorage or equivalent runtime context propagation).

Global mutable state must not be used to correlate dependency activity with Interactions.

If context propagation fails, recorder behavior remains fail-open for the app and records a diagnostic; the recorder may drop or degrade capture for the affected Interaction.

---

## 7. Body Capture and CAS Alignment

Recorder body handling MUST align with `docs/03-interaction-spec.md`:

- message body slots are represented as CAS reference objects in the manifest
- body bytes may be embedded in `objects` only per Interaction threshold rules
- larger bodies remain external CAS objects referenced by hash

The recorder may use streaming duplication primitives (for example `ReadableStream.tee()`) when available to avoid blocking the app's data path.

If recording is skipped or canceled, duplicate recorder-side streams must be canceled promptly to release resources.

---

## 8. Sanitization and Safety Invariants

Sanitization executes before persistence and before any bytes leave process boundaries for storage.

Normative invariants:

- unsanitized bytes are never persisted
- unsanitized bytes are never transmitted to external providers
- substitutions for sensitive values are internally consistent within an Interaction
- sanitizer/ruleset identity is included in artifact metadata

On sanitization failure, recorder policy is:

- application remains fail-open
- Interaction is dropped or hard-redacted into a safe persisted form
- unsanitized bytes are never retained as persisted artifacts

---

## 9. Storage Provider Contract Integration

The recorder persists through the Storage Provider contract defined in `docs/03-interaction-spec.md` and refined by `docs/04-storage-provider-spec.md`.

Recorder-facing responsibilities:

- hand off finalized manifest and required CAS closure asynchronously
- rely on provider idempotence/CAS integrity guarantees
- handle typed provider failures without surfacing failures into app code

Provider types may include local filesystem, object stores, in-memory, or remote opaque providers, but recorder behavior and artifact semantics remain unchanged across providers.

This RFC does not define a hosted-product upload REST API.

---

## 10. Failure Policy and Retries

Recorder internals may fail in storage, hashing, queueing, serialization, sanitization, or background workers.

Required behavior:

- never throw recorder failures into application request handling
- never alter HTTP status/body due to recorder failures
- emit structured diagnostics/metrics for failures and drops

Persistence retry policy is bounded and asynchronous:

- bounded retry count and retry window
- backoff with jitter
- deterministic drop/discard behavior when retries expire or queues fill

---

## 11. Resource Bounds and Load Shedding

Implementations MUST enforce configurable upper bounds for:

- active Interaction contexts
- buffered body bytes
- pending persistence queue depth
- CAS staging/cache footprint

When limits are exceeded, recorder chooses deterministic shedding actions such as sampling down, body elision, queue rejection, or Interaction drop.

Application latency/correctness takes precedence over recorder completeness.

---

## 12. Background Execution Model

Expensive work (hashing, serialization, compression, upload) runs outside the synchronous app request path where runtime facilities allow.

Runtime-specific mechanisms may differ (threads, tasks, wait-until style hooks), but all implementations must preserve:

- no intentional response-path blocking for recorder-internal work
- deterministic final artifact semantics
- bounded background queue growth

---

## 13. Self-Observability

Recorder implementations should expose at least:

- Interactions observed/finalized/persisted/dropped
- sanitization failures and redaction/drop counts
- provider failure counts and retry exhaustion counts
- queue depth and load-shedding activations
- context propagation failures

Metrics/reporting backends are implementation-specific.

---

## 14. Versioning and Compatibility

Recorder output carries inline version metadata required by the Interaction spec (`specVersion`, recorder/runtime/sanitizer/ruleset versions).

Backward consumption concerns are handled by replay/storage consumers, but recorder implementations must continue producing conformant artifacts for the declared `specVersion`.

Breaking format changes require a new Interaction spec major version and corresponding recorder updates.

---

## 15. Explicit Non-Goals

This recorder RFC does not define:

- full framework plugin contracts
- replay scheduler or matching internals
- hosted-product search/compare/collaboration/governance details
- non-HTTP capture semantics
- chunk-level stream timeline schema for v1

---

## 16. Contract Summary

The recorder is the production-safe artifact producer in the Epok system:

- observes HTTP request/dependency execution
- builds canonical Interaction manifest + CAS references
- enforces sanitize-before-persist invariants
- persists asynchronously through the Storage Provider seam
- remains fail-open and resource-bounded under stress

Adjacent RFCs should extend this behavior without redefining the Interaction artifact contract.
