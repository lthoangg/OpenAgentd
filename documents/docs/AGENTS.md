# documents/docs/ — Agent Instructions

Published documentation for users and developers. Use this tree to confirm product behavior before explaining or changing it.

## Where to look first

```
index.md          Documentation map by audience
features.md       Canonical feature catalogue
architecture.md   System architecture
guidelines.md     Development commands, style, testing patterns
desktop.md        Desktop build/release/signing pipeline
configuration/    Agent, provider, MCP, tool, skill config docs
agent/            Agent loop, hooks, tools, team, context, summarization docs
api/              API documentation
web/              Frontend/UI documentation
testing/          Testing guides
```

## Common feature checks

- Before claiming support: check `features.md` first.
- New user-visible feature: add a one-line `[vX.Y.Z]` entry in `features.md` and link deeper docs.
- Config/schema change: update the matching file under `configuration/`.
- Team/agent runtime change: update `agent/` docs and cross-link from `features.md` when user-visible.
- Desktop behavior change: update `desktop.md`.

## Style

- Preserve YAML frontmatter when present.
- Keep docs direct and practical; prefer commands and exact paths over prose.
- Use relative links and keep `index.md` useful as the entry point.
- Do not document commands that were not checked against repo files.

## Checks

No dedicated docs linter is configured. Manually verify relative links and run product checks when documenting commands or behavior.
