# Service Layer Guide

Services hold application behavior shared by API routes, CLI commands,
scheduler jobs, and the agent runtime. Keep them independent of FastAPI unless
the service explicitly implements an API transport boundary.

## Navigation

- `chat_service.py`: session/history orchestration; adjacent modules own
  revert/undo behavior and persisted stream history.
- `agent_manager.py`: agent-session lifecycle and routing, plus the authoritative
  `validate_workspace()` check.
- `stream_envelope.py`, `memory_stream_store.py`, and
  `event_broadcaster.py`: per-session and app-global live event behavior.
- `agent_fs.py`, `snapshot_service.py`, and coding-workspace services:
  workspace filesystem and snapshot behavior.
- `lsp/`: managed language servers, clients, diagnostics, and formatting;
  `app/agent/hooks/lsp.py` injects diagnostics into coding turns.
- `provider_connection.py` and `provider_usage.py`: provider connection and
  usage aggregation shared with UI/native surfaces.

## Conventions and risk

- Preserve async boundaries and use real
  `async_sessionmaker[AsyncSession]` factories in DB-facing tests.
- Do not add real sleeps to tests; inject or patch timing behavior.
- Workspace/file changes require traversal, symlink, media, and route tests.
  Do not create another workspace-root validator beside
  `agent_manager.validate_workspace()`.
- Session/history changes must account for SQLModel tables, stream state,
  scheduler/agent consumers, and frontend assumptions. Add a new Alembic
  revision when persisted schema changes.

## Checks

```bash
uv run pytest tests/services tests/api/routes -q
uv run ruff check app/services tests/services
uv run ty check app/
make verify-backend
```
