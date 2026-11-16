# documents/docs/ — Agent Instructions

This directory contains only the public feature catalogue.

## Files

```
index.md     Minimal public entry point
features.md  Index of the feature catalogue: headline, latest release, one link per area
features/    The catalogue's entries, one file per area
```

## Rules

- Record a shipped, user-visible capability in the area file under `features/` that `features.md` names for it; include its `[vX.Y.Z]` tag. Search `features/` first, and update an entry that already describes the feature.
- An area file has `title` and `description` frontmatter only. `features.md` alone carries the `updated:` date and the **Latest release** line; the release script and `make verify-version` read them there.
- Add an area file when no area fits, and link it from its pillar in `features.md`.
- Keep entries factual and concise. Do not add implementation guides, API references, configuration manuals, roadmaps, or troubleshooting pages here.
- Source code, tests, CLI help, and the UI are authoritative for behavior and operation.
- User-facing setup and product copy belong in `../../README.md`.

## Checks

Run `make verify-docs` after changes.
