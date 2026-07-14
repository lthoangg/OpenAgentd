# documents/ — Agent Instructions

Project documentation, screenshots/assets, styling specs, and tracked technical debt.

## Layout

```
docs/           Published developer/user docs; start at docs/index.md
assets/         Documentation assets
styling-specs/  Design and visual specs
techdebts/      Tracked technical debt notes
```

## Documentation rules

- `docs/features.md` is the canonical feature catalogue; check it before claiming capability status.
- Keep docs concise, factual, and linked from `docs/index.md` when adding a new entry point.
- When shipping a feature, update docs in this order:
  1. `docs/features.md`
  2. `../README.md` only for user-visible, pitch-worthy changes
  3. `docs/comparison.md` only for differentiating capabilities
  4. Deeper docs under `docs/`, linked back from the feature entry
- When removing a feature, mark it deprecated in `docs/features.md` before deleting it later.

## Style

- Many docs use YAML frontmatter (`title`, `description`, `status`, `updated`); preserve it when present.
- Prefer relative links and keep existing tone: direct, practical, developer-facing.
- Do not document speculative commands or features.

## Checks

Run `make verify-docs` for documentation changes. Use the canonical [change policy](docs/contributing/change-policy.md) to select additional checks when documentation changes commands, generated output, or product behavior.
