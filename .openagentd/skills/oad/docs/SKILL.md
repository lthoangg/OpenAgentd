---
name: oad/docs
description: OpenAgentd workflow for keeping the compact feature catalogue and README aligned with user-visible changes.
---

Sync the small set of product documentation affected by the current code changes. Called automatically by `oad/commit` — can also be used directly when the feature catalogue drifts.

## What to update

Inspect `git diff --cached` or `git diff HEAD`, then choose the smallest durable record:

- **Shipped user-visible capability** → add a concise, version-cited entry to `documents/docs/features.md`; it is the canonical catalogue.
- **Product story or first-run/setup change** → update `README.md` when users need to discover or act on it.
- **Non-obvious architecture or security rationale** → keep it beside the implementation; git history preserves the historical decision.
- **Future work, bugs, or roadmap changes** → use GitHub issues; do not add a roadmap or technical-debt document.
- **Implementation, API, configuration, CLI, operational, or UI-detail change** → keep the source, tests, CLI help, and UI authoritative. Add an inline comment only when it explains a non-obvious invariant or decision.
- **Nothing user-visible changed** → make no documentation change; note this briefly in the commit body.

## Rules

- Do not create deep implementation guides, API references, configuration manuals, styling specifications, troubleshooting pages, or duplicate operational docs under `documents/`.
- Do not turn ordinary control flow into comments. A code comment must explain *why* a non-obvious constraint exists, not restate *what* the code does.
- Keep feature entries factual, concise, and version-cited; mark removed features *(deprecated)* for at least one release before deleting them.
- Run `make verify-docs` after Markdown, README, or feature-catalogue changes.
- Complete the documentation pass before handing control back to `oad/commit`.
