# tests/ — Agent Instructions

Pytest suite for the FastAPI backend and agent runtime. Tests mirror `app/` with the redundant `app/` prefix dropped.

## Tech stack

- Pytest, pytest-asyncio, respx, FastAPI dependency overrides.
- In-memory SQLite fixtures redirect `app.core.db`; tests should not require an external database.

## Layout

```
agent/      Tests for agent loop, hooks, providers, tools, teams, MCP, plugins
api/        Route tests
cli/        CLI command tests
core/       Config, paths, DB, auth, telemetry tests
models/     SQLModel schema tests
scheduler/  Scheduled task runtime tests
services/   Service-layer tests
conftest.py Shared fixtures and DB redirection
```

## Essential commands

```bash
uv run pytest --no-cov -q
uv run pytest --no-cov tests/path/test_file.py::test_name -q
uv run pytest --no-cov --durations=0 -q
uv run ruff check app/ tests/
uv run ruff format --check app/ tests/
```

## Conventions

- Put tests for `app/<path>/<module>.py` in `tests/<path>/test_<module>.py`.
- Prefer real async session factories from fixtures over mock context managers.
- Override FastAPI dependencies with `app.dependency_overrides[dep] = override`.
- Mock sleeps/timeouts in production code; do not wait out real delays.
- Fake `os.execvp` in CLI tests by raising `SystemExit(0)`.

## Source of truth

- Test commands and conventions are defined in this file, the Makefile, and the tests themselves.
