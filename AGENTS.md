## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Repository boundary

This repository is **public Epok core** only (Interaction, recorder, replay, Storage Provider).

- Do not add hosted-product design, Outcome/Notification vocabulary, workspace/catalog/API/MCP product specs, or default commercial endpoints.
- Derived product layers belong in the private `epok-saas` repository.
