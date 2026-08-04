# Epok

## Storage Provider Specification

**Document Version:** 1.0.0 (Draft)

**Status:** Engineering RFC

**Audience:** Recorder implementers, Replay implementers, Storage Provider authors, SDK/tooling authors

---

## 1. Purpose

A **Storage Provider** persists and retrieves Interaction packages: a sanitized manifest plus the reachable CAS object set.

This document defines the persistence seam. It does not define hosted-product APIs, authentication product models, catalogs, or alerting.

---

## 2. Responsibilities

1. Persist and fetch the sanitized manifest as bytes with metadata needed for integrity checks (`id`, `specVersion`, `manifestHash` discoverability).
2. Put/get CAS objects by `{ alg, hash }`, returning exact bytes and size, with hash verification on write and optional verify-on-read.
3. Expose existence checks / idempotent writes so repeated captures of the same hash do not duplicate object storage semantics.
4. Support enumeration primitives needed by replay/local tooling at RFC level (list/query capability may be provider-specific; core contract stays minimal).

---

## 3. Behavioral Contract

- **Async, non-blocking:** provider calls are asynchronous and must not require blocking the app event loop.
- **Deterministic errors:** return typed failures (`unavailable`, `timeout`, `quota`, `integrity`, `not_found`, `unauthorized`) so recorder/replay can apply policy predictably.
- **Atomicity expectation:** manifest publish is all-or-nothing with respect to required CAS reachability for that Interaction; no successful manifest write that points to missing required objects.
- **Durability signal:** provider declares best-effort vs durable semantics; RFC behavior does not assume stronger guarantees than declared.

---

## 4. Recorder-Facing Failure Policy

- Recorder remains **fail-open for application traffic**.
- On provider failure, recorder may retry within bounded budget; if persistence still fails, it drops the Interaction (or hard-redacts to policy) and emits diagnostics.
- Unsanitized bytes must never be persisted; provider receives only post-sanitization content.

---

## 5. Provider Kinds

Interchangeable at this seam if they honor the same manifest/CAS/integrity behavior:

- local filesystem
- in-memory (tests)
- object stores
- opaque remote providers configured with an explicit base URL (and caller-supplied auth material)

### 5.1 Opaque remote transport

Remote providers MAY expose minimal hash-addressed push/pull of manifests and CAS objects over HTTP(S).

Requirements for implementations shipped from this repository:

- Base URL is **explicitly configured** by the operator.
- **No default** commercial or product hostname is embedded in client code or package config.
- Transport speaks persistence only (put/get/exists by hash). It must not encode hosted-product resources (workspaces, policies, notification APIs, catalog search, and similar).

---

## 6. Explicit Non-Goals

This specification does not define:

- hosted catalog, search, or governance product surfaces
- workspace or multi-tenant product models
- notification / alerting product APIs
- billing or commercial packaging
