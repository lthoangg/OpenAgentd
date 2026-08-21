# Repository Agent Assets

This subtree contains tracked commands, snippets, and skills used while
working on OpenAgentd. It does not contain the application's user-owned runtime
configuration.

## File contracts

- Command and snippet Markdown files require YAML frontmatter with a
  `description` field.
- Every skill entry point is `skills/<name>/SKILL.md` with `name` and
  `description` frontmatter. Keep detailed supporting material in that
  skill's `reference/` or `scripts/` directory.
- Keep commands non-destructive by default. Never embed credentials,
  machine-local paths, or copied `.env` values.
- Do not edit ignored `.openagentd/dev/`, `data/`, `state/`, `sessions/`, or
  other runtime output as repository source.

## Checks

```bash
make verify-docs
make prompt-budget
```

Run `make prompt-budget` when a bundled prompt, tool protocol, or skill body
changes; use `make prompt-budget-json` when a stable comparison is needed.
