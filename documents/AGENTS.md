# documents/ — Agent Instructions

Product documentation is intentionally small.

## Layout

```
docs/     Version-cited feature catalogue and its minimal entry point
assets/   Brand, README, and screenshot assets
```

## Rules

- `docs/features.md` is the canonical catalogue of shipped user-visible features.
- Keep behavior, implementation detail, configuration, and operational guidance in code, tests, CLI help, and the UI rather than duplicating them here.
- Add an inline source comment only when it explains a non-obvious invariant or decision; do not restate ordinary control flow.
- Keep user-facing installation and product overview in `../README.md`.
- Keep non-obvious rationale beside the implementation; rely on git history for historical decisions.
- Assets remain referenced from the README or app source; do not remove an asset without checking its incoming references.

## Checks

Run `make verify-docs` after documentation, README, or Markdown-link changes.
