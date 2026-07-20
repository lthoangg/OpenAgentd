# app/ — Agent Instructions

FastAPI backend, CLI, agent runtime, persistence, scheduler, and service-layer code for OpenAgentd.

## Tech stack

- Python `>=3.14`, managed with `uv`.
- FastAPI, SQLModel/SQLite, Pydantic v2, Alembic, SSE, loguru.
- CLI entry point: `openagentd = app.cli:main`.

## Layout

```
agent/       Agent loop, providers, tools, MCP, teams, plugins, schemas
api/         FastAPI routes and API dependencies
cli/         Command-line entry points and subcommands
core/        Config, paths, database, auth, telemetry primitives
models/      SQLModel tables and persistence models
scheduler/   Scheduled task runtime
services/    Business logic used by routes and agent runtime
migrations/  Alembic revisions
server.py    FastAPI app factory/export
```

## Essential commands

```bash
uv sync
uv run ruff check app/ tests/
uv run ruff format --check app/ tests/
uv run ty check app/
uv run pytest --no-cov -q
make run        # API only on :8000
make dev        # API reload + Vite dev server
```

## Code style

- Use `from __future__ import annotations`, `|` unions, and strict signature types.
- Keep routes thin; put logic in `services/`, `agent/`, or `core/` helpers.
- Use absolute imports from `app`.
- Use Pydantic v2 and `ConfigDict(extra="ignore")` for external provider payloads.
- Use loguru formatting: `logger.info("event_name key={}", value)`.

## Post-implementation checklist

```bash
uv run ruff check app/ tests/ && uv run ruff format --check app/ tests/ && uv run ty check app/ && uv run pytest --no-cov -q
```

## CLI command map

| Command | Module |
|---------|--------|
| `export` | `app/cli/commands/export.py` — packs config into a `.tar.gz` for server migration |
| `import` | `app/cli/commands/importcmd.py` — unpacks a migration archive (named `importcmd` to avoid the Python builtin) |
| `migrate` | `app/cli/commands/migrate.py` — imports from OpenClaw / Hermes |
| `init` | `app/cli/commands/init.py` — first-time setup |
| `lsp` | `app/cli/commands/lsp.py` — inspect/install managed language-server components |

## Documentation pointers

- CLI server bind/auth persistence: `app/core/server_settings.py` (`server.yaml`); shared agent/runtime settings remain in `app/core/runtime_settings.py` (`settings.yaml`).
- Backend conventions: source modules, adjacent tests, and Make targets are authoritative.
- Architecture: follow the package layout above and trace runtime behavior through the source.
- Server binding/auth invariant: `documents/adrs/0002-require-authentication-for-non-loopback-bindings.md`.
- ASGI performance backends: `documents/adrs/0008-use-native-uvicorn-performance-backends.md`.
- Feature catalogue: `documents/docs/features.md`.
