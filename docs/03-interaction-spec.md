# Epok

## Interaction Specification

**Document Version:** 1.0.1 (Draft)

**Status:** Engineering RFC

**Audience:** Recorder implementers, Replay engine implementers, Storage Provider authors, SDK/tooling authors

---

## 1. Purpose

An **Interaction** is the canonical, immutable record of one inbound HTTP execution and the outbound HTTP dependencies observed during that execution.

The Interaction format exists to make runtime behavior portable across recorders, storage providers, and replay engines.

This document specifies:

- the logical artifact shape
- lifecycle and state transitions
- integrity and versioning requirements
- sanitization requirements
- ordering and timing semantics
- explicit non-goals

---

## 2. Scope and Boundaries

### In scope

- One inbound HTTP request maps to one Interaction.
- Outbound HTTP dependencies initiated via `fetch` (or runtime adapters preserving equivalent semantics).
- Deterministic representation of request/response payloads, headers, ordering, and timing metadata.

### Out of scope

- Non-HTTP primary entrypoints (queues, cron, WebSocket-primary interactions).
- Full machine-state capture (DB snapshots, process memory, filesystem state, scheduler state).
- Projection format definitions (including `.cif`) beyond the concept of projections as views.
- Chunk-level stream timelines in v1 (v1 captures assembled bodies plus started/ended timing fields).

---

## 3. Artifact Model

An Interaction is a **logical package**:

1. one JSON manifest
2. zero or more content-addressed objects (CAS)

Portability is defined as the manifest plus every CAS object reachable from the manifest.

The physical packaging format is intentionally unspecified in v1.

### 3.1 Top-level manifest shape

The manifest includes these top-level sections:

```text
id
specVersion
metadata
inbound
dependencies[]
response
replay
objects
integrity
```

- `id`: RFC 9562 UUIDv7 string.
- `specVersion`: semver string for this Interaction format.
- `objects`: optional hash-keyed embedded object map for small payload bytes.
- `integrity`: manifest/object integrity metadata.

### 3.2 Canonical skeleton (illustrative)

```json
{
  "id": "018f6b3f-32f2-7f9a-b66d-1f7a26134f0c",
  "specVersion": "1.0.0",
  "metadata": {},
  "inbound": {},
  "dependencies": [],
  "response": {},
  "replay": {},
  "objects": {},
  "integrity": {}
}
```

The skeleton is illustrative. Field-level requirements are normative in the sections below.

---

## 4. Lifecycle

An Interaction progresses through these logical states:

1. **Created**: `id` allocated and capture context initialized.
2. **Collecting**: inbound/dependency/response data observed.
3. **Completed**: host response completes (or terminal error recorded).
4. **Sanitized**: all persisted bytes are sanitized in-memory.
5. **Finalized**: manifest assembled, `integrity` computed, immutable.
6. **Persisted**: manifest/CAS handed to the Storage Provider contract.

After **Finalized**, the Interaction is immutable.

### 4.1 Partial and aborted executions

If execution terminates early, the recorder may persist a partial Interaction if it still satisfies this spec's integrity and sanitization rules. There is no `PartialInteraction` fork and no metadata lifecycle enum.

Incompleteness is represented in the existing message model:

- top-level `response` is `null` when inbound terminal was not observed (client abort / close without finish / throw before headers)
- a started dependency is unterminated when `response` is `null` and `error` is absent

Replay may refuse executable re-run or snapshot playback when `response` is `null`. Integrity validation does not treat incompleteness as corruption.

---

## 5. HTTP Message Model

The same logical HTTP message shape is used for:

- `inbound`
- each dependency request/response
- top-level `response`

### 5.1 Required message fields

Depending on request vs response context:

- `protocol` (for example `HTTP/1.1`, `HTTP/2`)
- `method` (request messages)
- `url` (request messages; full observed URL with sanitized query values as needed)
- `status` (response messages)
- optional `statusText` (response messages)
- `headers[]` as ordered `{ "name": string, "value": string }`
- optional `trailers[]` with the same shape
- `body` as a CAS reference object (see Section 6)

### 5.2 Header semantics

- Header order is preserved.
- Duplicate headers are preserved.
- No separate cookie structure is required by the format.

---

## 6. Body and CAS Rules

### 6.1 Body representation rule

Every HTTP body slot is represented as a CAS-style reference object. The manifest never stores body bytes directly on the message object.

```json
{
  "body": {
    "cas": {
      "alg": "sha256",
      "hash": "4f8d7a6c...",
      "size": 12345,
      "contentType": "application/json",
      "contentEncoding": null
    }
  }
}
```

### 6.2 CAS fields

- `alg`: `sha256` in v1.
- `hash`: lowercase hex digest.
- `size`: byte length of persisted sanitized bytes.
- `contentType`: media type when known.
- `contentEncoding`: transfer/content encoding descriptor when applicable; else `null`.

### 6.3 Size threshold and object placement

Threshold decision in v1:

- if body size `< 16 KiB`, bytes may be embedded in `objects`
- if body size `>= 16 KiB`, bytes must remain external CAS storage

If embedded, the corresponding `objects[hash]` entry shape is:

```json
{
  "encoding": "utf-8",
  "data": "..."
}
```

Allowed encodings in v1: `utf-8` and `base64`.

### 6.4 CAS resolution rule

To resolve body bytes for replay or tooling:

1. check `objects` by hash
2. if absent, resolve from Storage Provider CAS

---

## 7. Metadata

### 7.1 Required metadata (minimum)

- `capturedAt` (wall-clock timestamp)
- `recorder.name`
- `recorder.version`
- `runtime.name`
- `runtime.version`
- `sanitizer.version`
- `ruleset.id`
- `ruleset.hash`
- `captureMode`

### 7.2 Optional enrichment metadata

- `service.name`
- `environment`
- `region`
- `hostname`
- `deployment.id`

Optional enrichment must never be required for format validity.

---

## 8. Dependency Timeline

`dependencies[]` records outbound HTTP calls in observed execution order.

Each dependency row includes:

- `seq` (unique uint in this Interaction; invoke order)
- optional `parentSeq`
- `startedAt` monotonic offset from Interaction start (ms)
- `endedAt` monotonic offset from Interaction start (ms); completion order is this field, not `seq`
- `request` HTTP message
- `response` HTTP message or `null`
- optional `error` object with at least `type` and `message`

Retries are represented as separate dependency rows, not nested retry arrays.

---

## 9. Top-level Response

`response` records what the host application returned to the inbound caller, or `null` when inbound terminal was not observed.

When present, it includes:

- HTTP response message fields (Section 5)
- `startedAt`/`endedAt` timing fields for response lifecycle

v1 persists assembled body bytes that reached stream end. Unfinished body streams are stored as empty CAS slots, not prefixes. Chunk event timelines are out of scope.

---

## 10. Replay Hints

`replay` carries deterministic replay hints that do not redefine recorded facts.

v1 includes signature regeneration hints via `replay.signatures[]`:

```json
{
  "target": "dependencies[2].request.headers.Authorization",
  "algorithm": "hmac-sha256",
  "payload": "dependencies[2].request.body",
  "secretRef": "payments.webhook.secret",
  "replaced": true
}
```

`secretRef` is symbolic only. Secrets are supplied at replay time from local configuration, never persisted in the Interaction.

---

## 11. Integrity and Identity

### 11.1 Identity

- `id` is UUIDv7 and assigned at Interaction creation.

### 11.2 Manifest hash

`integrity.manifestHash` is the SHA-256 digest of canonicalized manifest bytes with integrity-self-reference omitted/zeroed per implementation rules.

v1 defines a single manifest hash concept (no second top-level Interaction hash).

### 11.3 Object closure

`integrity.objects[]` contains the closure set of every required CAS object:

```json
{
  "alg": "sha256",
  "hash": "4f8d7a6c...",
  "size": 12345
}
```

### 11.4 Optional recorder signature

`integrity.recorderSignature` is optional in v1.

---

## 12. Sanitization Invariants

Sanitization runs before any persistence of manifest or CAS bytes.

Normative invariants:

- unsanitized bytes must never be persisted
- unsanitized bytes must never be transmitted to external storage providers
- substitutions for sensitive values must remain consistent within an Interaction
- Interaction validity requires sanitizer/ruleset version metadata

If sanitization cannot produce a safe artifact, recorder behavior follows fail-open application semantics and drops or hard-redacts the Interaction artifact according to recorder policy.

---

## 13. Versioning and Compatibility

- `specVersion` is inline and semver.
- v1 starts at `1.0.0`.
- Major version increments denote breaking parse/replay format changes.

Recorder/runtime/sanitizer/ruleset versions remain inline in metadata; Indexes outside the artifact may normalize without changing artifact semantics.

---

## 14. Projections as Views

Projections (CLI views, markdown, timeline summaries, MCP payloads, and other renderings) are derived views over the canonical Interaction artifact.

Projection formats are not alternative canonical storage formats in this spec.

Concrete projection schemas, including `.cif`, are deferred.

---

## 15. Explicit Non-Goals

This specification does not attempt to define:

- replay engine internals
- hosted-product API or authentication model
- storage-provider transport APIs
- non-HTTP trigger semantics
- chunk-level stream event schemas
- full framework plugin contracts
- derived product classifications or alerting workflows (out of scope for this repository; see `docs/adr/0001-interaction-recorded-reality-only.md`)

---

## 16. Contract Summary

The Interaction format is the canonical execution artifact:

- Recorder implementations produce it.
- Storage Providers persist manifest and CAS per contract.
- Replay implementations consume it in deterministic modes.
- Storage Providers persist/retrieve it without mutating runtime facts.

All adjacent RFCs must align to this structure rather than redefining it.
