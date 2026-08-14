# Epok

Epok captures a single HTTP-inbound application execution as a portable, immutable **Interaction** and replays it later. The Interaction is recorded reality only. Derived product classifications and alerting workflows are out of scope for this repository.

## Language

**Interaction**:
The canonical, immutable record of one HTTP-inbound application execution (inbound request, outbound dependency timeline, application response), packaged as a manifest plus CAS objects.
_Avoid_: trace, session, cassette, recording (as the artifact name)

**Manifest**:
The JSON document that describes an Interaction and references every body by content hash.
_Avoid_: cassette file, HAR log

**CAS object**:
An immutable byte payload addressed by SHA-256 of its exact persisted bytes, either embedded in the manifest `objects` map or stored by a Storage Provider.
_Avoid_: attachment, body file, blob (unless meaning generic object storage)

**Dependency**:
One outbound HTTP call observed during an Interaction, with its own sequence id and monotonic timing.
_Avoid_: span, child request (as the artifact term)

**Storage Provider**:
The interface that persists and retrieves manifests and CAS objects. May record multiple capture ids against one manifest hash; that occurrence index is not part of the Interaction artifact. Remote providers are configured explicitly; there is no default hosted endpoint in this repository.
_Avoid_: database, SaaS (as a synonym for this interface)

**Observation**:
The Fetch-shaped view of the inbound request, outbound Dependencies, and host response while an Interaction is being captured. Not the Interaction artifact, and not a telemetry backend.
_Avoid_: trace, span, telemetry (as the Epok term)

**Projection**:
A derived view over an Interaction for humans or tools. Not an alternative storage format.
_Avoid_: export format (when meaning the canonical artifact)
