---
name: oad/docs
description: OpenAgentd workflow for syncing project documentation with recent code changes.
---

Sync docs affected by the current code changes. Called automatically by `oad/commit` — can also be invoked directly when docs drift is the only concern.

## What to update

Look at the diff (`git diff --cached` or `git diff HEAD`) and ask: what does a user, operator, or future contributor need to know that has changed?

- **Behavior changed** → update the relevant doc in `documents/docs/`; `features.md` is the canonical feature catalogue.
- **API / route / schema changed** → update any API reference, migration notes, or operator docs for that surface.
- **Install / setup / config changed** → update `README.md` or the relevant install/config doc.
- **Roadmap item completed or invalidated** → update `documents/docs/roadmap.md`.
- **Nothing user- or operator-visible changed** → no doc update needed; note this briefly in the commit body.

## Rules

- **Don't duplicate** — if the behavior is already captured elsewhere, add a cross-reference instead of copying prose.
- **Don't include code** — docs describe behavior and outcomes, not implementation internals.
- **Keep it short** — one clear sentence beats a paragraph of hedging. Update existing sections in-place rather than appending.
- **One pass** — update all affected docs before handing back to `oad/commit`; don't leave partial updates.
