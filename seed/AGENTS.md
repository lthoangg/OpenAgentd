# seed/ — Agent Instructions

Default agents, optional skills, and MCP config copied into a user's config directory by `openagentd init`.

## Layout

```
agents/   Seed agent `.md` files; exactly one per team directory has `role: lead`
skills/   One skill per directory, each with `SKILL.md`
mcp.json  Empty default MCP server config
README.md Maintainer notes; not copied by init
```

## Conventions

- Treat these files as public templates for new installs; never include secrets.
- Existing users keep their copies, so seed changes affect only new installs or users who manually copy updates.
- `openagentd init` rewrites agent `model:` values to the user's selected provider/model.
- Keep skill directories self-contained with any helper scripts/templates they need.
- Keep agent prompt bodies tool-agnostic; runtime capabilities can change.

## Checks

```bash
uv run ruff check app/ tests/
uv run pytest --no-cov -q tests/cli
```

Run focused CLI/init tests when changing seed install behavior or validation logic.

## Source of truth

- Maintainer notes: `README.md`.
- Agent frontmatter contract: `app/agent/loader.py` and its focused tests.
- Skills contract: `app/agent/plugins/` and builtin skill definitions.
