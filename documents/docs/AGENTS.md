# documents/docs/ — Agent Instructions

This directory contains only the public feature catalogue.

## Files

```
index.md     Minimal public entry point
features.md  Canonical version-cited catalogue of shipped user-visible features
```

## Rules

- Update `features.md` for a shipped, user-visible capability; include its `[vX.Y.Z]` tag.
- Keep entries factual and concise. Do not add implementation guides, API references, configuration manuals, roadmaps, or troubleshooting pages here.
- Source code, tests, CLI help, and the UI are authoritative for behavior and operation.
- User-facing setup and product copy belong in `../../README.md`.

## Checks

Run `make verify-docs` after changes.
