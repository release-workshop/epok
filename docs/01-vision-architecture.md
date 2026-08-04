# Epok

## Vision & Architecture

**Document Version:** 1.3.0 (Draft)
**Status:** Engineering RFC
**Target Runtimes:** Node.js, Bun, Deno, Cloudflare Workers, WinterCG-compatible runtimes

---

## 1. Vision

Epok makes runtime HTTP behavior portable.

Source code, infrastructure, and build artifacts are already portable. Real executions are not. Incident analysis still relies on reconstruction from partial signals.

Epok treats one inbound HTTP request and its dependency activity as a durable artifact called an **Interaction**. That artifact can be replayed later for debugging, testing, and investigation without requiring access to the original production environment.

> **Runtime behavior becomes a portable engineering asset.**

---

## 2. RFC Set and Responsibilities

This document is the boundary-and-orientation RFC. Detailed contracts live in companion RFCs:

1. `docs/02-recorder-spec.md` — capture lifecycle, interception contract, sanitization, and persistence behavior.
2. `docs/03-interaction-spec.md` — canonical Interaction wire format (manifest + CAS), integrity, and invariants.
3. `docs/04-storage-provider-spec.md` — persistence seam for manifests and CAS objects (local and opaque remote).
4. `docs/05-replay-spec.md` — replay mode semantics, matching/timing behavior, and failure policy.

This Vision RFC intentionally avoids re-specifying those details. If a statement conflicts with a companion RFC, the companion RFC wins for that scope.

---

## 3. System Boundary

### 3.1 In scope

- HTTP-inbound Interactions: one inbound HTTP request starts one Interaction.
- Outbound dependency behavior initiated by that request (via `fetch` and adapter-equivalent seams).
- Sanitized persistence of Interaction artifacts.
- Deterministic-enough replay semantics defined by the Replay RFC.

### 3.2 Out of scope

- Non-HTTP primary entrypoints (queues, cron, WebSockets as primary Interaction triggers).
- Full machine-state capture (DB snapshots, process memory, scheduler replay).
- Turning this core into a distributed tracing graph product.
- Hosted product design (catalog, governance, alerting, API/MCP product surfaces). Those are outside this repository.

---

## 4. Standalone core

Epok core is usable without any hosted product:

- Recorder + Interaction format + local storage + local replay operate offline.
- Interactions are standalone artifacts and remain valid without any central catalog.
- Core answers **what happened**: recorded reality for a single execution, replayable locally.
- No required global correlation graph.

Optional remote Storage Providers may persist the same artifact via an explicitly configured opaque endpoint. This repository does not ship a default hosted base URL or hosted product API shapes.

---

## 5. Architectural Principles

1. **Production first:** recording never compromises application correctness or availability.
2. **Fail open:** recorder/storage/sanitization failures do not fail the host request.
3. **Sanitize before persist:** unsanitized bytes are never persisted as Interaction artifacts.
4. **Bounded overhead:** memory/CPU/background work are bounded; pressure favors dropping recordings over degrading the app.
5. **Contract-driven portability:** shared artifact and storage contracts, runtime-specific adapters.

---

## 6. High-Level Architecture

```text
Inbound HTTP request
  -> host application execution
  -> recorder observes inbound + dependencies
  -> sanitizer applies policy
  -> Interaction manifest + CAS object set finalized
  -> Storage Provider persists artifact package
  -> Replay consumes stored Interactions later
```

The architecture is intentionally seam-based:

- Artifact contract seam: `docs/03-interaction-spec.md`
- Capture/persist seam: `docs/02-recorder-spec.md`
- Storage Provider seam: `docs/04-storage-provider-spec.md`
- Replay behavior seam: `docs/05-replay-spec.md`

---

## 7. Compatibility and Evolution

- Interaction artifacts are versioned and immutable once finalized.
- Replay implementations preserve backward compatibility across supported Interaction spec versions.
- Recorder/runtime/sanitizer versions remain inline on artifacts to keep provenance explicit.
- New capabilities should extend companion RFCs instead of broadening this Vision RFC.

---

## 8. Explicit Non-Goals

Epok core does not attempt to:

- guarantee deterministic results for code paths that depend on mutable external state outside captured HTTP behavior;
- replace observability platforms or distributed tracing systems;
- define hosted-product APIs, workspace models, or alerting workflows in this repository.
