# Backend Guide

Python `>=3.14` backend managed with `uv`. This subtree contains the FastAPI
app, CLI, agent runtime, SQLModel persistence, scheduler, and migrations.

## Ownership

- `api/`: HTTP/SSE assembly, request validation, dependencies, and response
  shaping. Durable behavior does not belong in route handlers.
- `services/`: application behavior shared by routes, CLI, scheduler, or the
  agent runtime.
- `agent/`: provider, tool, MCP, permission, prompt, and single-agent runtime.
- `core/`: configuration, paths, database/session factories, auth, logging,
  and telemetry primitives.
- `models/` and `scheduler/models.py`: persisted SQLModel tables.
- `cli/`: the `openagentd = app.cli:main` command and subcommands.
- `migrations/`: Alembic environment and ordered schema revisions.

Use absolute imports from `app`. Backend modules consistently use
`from __future__ import annotations`, `|` unions, typed signatures, Pydantic v2,
and loguru placeholder formatting such as `logger.info("event key={}", value)`.
External provider payload models use the existing permissive
`ConfigDict(extra="ignore")` pattern where forward-compatible fields are
expected.

## Development

```bash
uv sync --frozen
make run
make dev
uv run pytest tests/path/test_file.py::test_name -q
uv run ruff format app/ tests/            # apply Python formatting
make migrate                              # development DB only
make revision MSG="describe change"       # create a new revision
make build                                # API-only Python package
```

Production startup runs migrations automatically; the Make migration targets
operate on source-checkout development paths unless the environment is
explicitly changed.

## Checks

```bash
make verify-backend
```

This is the canonical backend contract: Ruff lint and format check, `ty` on
`app/`, and pytest with four xdist workers. Use focused test/lint commands while
iterating, then run the target before finishing backend changes.

## Constraints

- Add or update tests under the mirrored `tests/` path for behavior changes.
- Treat auth, externally supplied paths, subprocesses, tool execution, MCP
  launch, and provider credentials as security-sensitive; follow the root
  invariants and the nearest child guide.
- Do not edit packaged copies under `app/_web_dist/` or sidecar bundles. They
  are generated build output.
- When a backend wire or SSE shape changes, update the consumers under
  `web/src/` and run both backend and web checks.
