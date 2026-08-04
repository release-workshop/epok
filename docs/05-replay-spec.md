# Epok

## Replay Specification

**Document Version:** 1.0.0 (Draft)

**Status:** Engineering RFC

**Audience:** Replay implementers, recorder implementers, SDK/tooling authors

---

## 1. Purpose

Replay makes recorded runtime behavior reusable by consuming canonical Interaction artifacts and producing deterministic, inspectable results.

This specification defines replay behavior at the contract level:

- replay modes and their intended use
- matching and ordering guarantees
- timing behavior and limits
- signature regeneration contract
- failure and mismatch handling
- light CLI surface

This specification does not define replay engine internals.

---

## 2. Inputs and Dependencies

Replay consumes:

- one Interaction manifest
- the CAS object closure referenced by that manifest
- local replay configuration (secrets, mode selection, policy knobs)

Replay operates on sanitized persisted bytes only.

The canonical data model for recorded facts is defined in `docs/03-interaction-spec.md`. This document adds replay semantics over that model.

---

## 3. Replay Modes

Replay has two first-class modes over the same artifact.

### 3.1 Executable Re-run (Primary)

Replay executes the target application path while injecting recorded dependency behavior so the application can be exercised with production-observed inputs.

Intended use:

- deterministic debugging and incident reproduction
- CI verification against known executions
- compatibility checks across code changes

### 3.2 Mocking/Snapshot Playback (Secondary)

Replay serves recorded dependency behavior as fixtures without requiring full application re-execution semantics.

Intended use:

- fast tests and contract snapshots
- local tooling and fixture-backed development
- deterministic dependency stubbing from real artifacts

Both modes are normative consumers of the same Interaction format.

---

## 4. Determinism Model

Replay determinism is defined relative to recorded HTTP behavior, ordering, and persisted bytes.

Replay guarantees:

- byte-stable body materialization from Interaction `objects` or provider CAS
- deterministic dependency matching policy per mode
- deterministic mismatch policy application per mode
- deterministic reporting of divergences from the recording

Replay does not guarantee deterministic outcomes for application logic that depends on mutable external state, wall clock, process randomness, or side effects outside recorded dependency seams.

---

## 5. Matching and Ordering

### 5.1 Executable Re-run matching

Executable re-run mode validates outbound dependency attempts against the recorded dependency rows (`dependencies[]`) and their replay hints.

Default policy is strict: mismatches are terminal (see Section 8).

### 5.2 Snapshot mode matching

Snapshot mode uses a hybrid matcher:

1. signature-oriented match
2. sequence fallback within the signature bucket

The signature-oriented key SHOULD include:

- method
- URL
- selected headers
- optional body hash

If multiple candidates remain, choose by recorded sequence order to preserve deterministic resolution.

### 5.3 Ordering rules

- `dependencies[].seq` order is canonical for outbound call ordering within an Interaction.
- Retries are independent dependency rows and are matched as such.
- `parentSeq` is advisory structure; it may guide diagnostics but does not replace `seq` ordering.

---

## 6. Timing Semantics

Replay timing semantics are based on Interaction monotonic offsets (`startedAt`, `endedAt`) rather than wall-clock capture timestamps.

### 6.1 Timing modes

- **Instant mode:** deliver dependency responses as soon as matching succeeds.
- **Real-time mode (best-effort):** delay dependency completion to approximate recorded durations and relative ordering.

### 6.2 Real-time mode guarantees and non-guarantees

Guarantees:

- never complete a dependency earlier than its modeled recorded duration when the runtime scheduler allows
- preserve relative sequence ordering constraints

Non-guarantees:

- exact micro-timing equivalence to the original runtime
- scheduler-level fairness or event-loop fidelity
- chunk-event reconstruction in v1 (assembled body plus span timing only)

When exact pacing is infeasible (runtime limits or scheduling drift), replay records the deviation in diagnostics.

---

## 7. Signature Regeneration

Some dependencies require regenerated auth/signature fields at replay time.

Replay uses `replay.signatures[]` hints from the Interaction artifact:

- `target`: where to write the regenerated value
- `algorithm`: signature algorithm
- `payload`: what bytes/fields are signed
- `secretRef`: symbolic local secret reference
- `replaced`: whether recorded value was substituted

Normative rules:

- secrets are never read from the Interaction artifact
- `secretRef` resolves only from local replay configuration
- regenerated values are applied before outbound dependency matching/sending
- missing or invalid secret material is a replay mismatch/failure

---

## 8. Failure and Mismatch Policy

### 8.1 Strict mode (default)

Replay defaults to strict fail-fast behavior.

On first terminal mismatch or invariant violation, replay:

- stops the current replay run
- emits a structured failure report
- marks the run as non-deterministic / failed

Terminal examples:

- no candidate match for a required dependency
- CAS object missing or hash mismatch
- required signature regeneration failure
- unsupported `specVersion` for configured compatibility policy

### 8.2 Diagnostic lenient mode

Replay MAY provide an explicit diagnostic lenient mode for investigation ergonomics.

In diagnostic lenient mode:

- replay attempts to continue after mismatches where safe
- each deviation is logged as structured diagnostics
- the run must not be labeled deterministic success

Lenient mode is for analysis, not correctness claims.

---

## 9. Compatibility and Version Handling

Replay must evaluate `specVersion` and apply compatibility policy before execution.

Minimum behavior:

- reject unsupported major versions with explicit diagnostics
- surface recorder/runtime/sanitizer/ruleset metadata to reports
- preserve backward consumption for supported historical versions

Compatibility transformation logic, if any, is implementation-specific and out of scope for this RFC.

---

## 10. CLI Surface (Light Sketch)

The CLI is an ergonomics layer over replay behavior, not a second protocol.

Illustrative command surface:

- `epok replay run <interaction-ref>`: execute in primary mode
- `epok replay mock <interaction-ref>`: run snapshot/mock mode
- `epok replay validate <interaction-ref>`: integrity + compatibility checks only

Common options:

- `--mode strict|diagnostic-lenient`
- `--timing instant|realtime`
- `--secrets <path-or-provider-ref>`
- `--report <json|text|md>`

The exact command grammar is intentionally deferred; this section exists to keep mode/policy concepts visible to users.

---

## 11. Observability Outputs

Replay should produce machine-readable run reports that include:

- Interaction identity (`id`, `specVersion`, `manifestHash`)
- selected replay mode and timing mode
- mismatch list with dependency references
- signature regeneration outcomes (without secret material)
- timing drift notes in real-time mode
- terminal result classification

Report schemas are implementation-specific in v1.

---

## 12. Explicit Non-Goals

This specification does not define:

- internal replay scheduler architecture
- runtime-specific concurrency primitives
- storage-provider transport APIs
- hosted catalog/search product behavior
- chunk-level streaming event timelines
- framework-specific plugin contracts

---

## 13. Contract Summary

Replay is a deterministic consumer of the canonical Interaction artifact with two first-class modes:

- executable re-run for primary reproducibility workflows
- snapshot/mock playback for fixture-oriented workflows

Strict fail-fast is the default correctness posture.
Diagnostic lenient mode exists for investigation and never represents deterministic success.
