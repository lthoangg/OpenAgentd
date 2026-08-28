# API Guide

This subtree owns FastAPI assembly, dependencies, request/response schemas, and
HTTP, WebSocket, and SSE routes.

## Boundaries

- `app.py` owns middleware, lifecycle, and router registration; `deps.py` owns
  shared dependencies; `routes/` groups transport handlers; `schemas/` holds
  reusable wire models.
- `routes/team/` is mounted at `/api/session` — the directory name is
  historical, the URL is authoritative. Do not add a `/api/team` alias; see
  `documents/adrs/0002-single-session-runtime.md`.
- Keep handlers focused on transport validation/status/response shaping.
  Delegate durable behavior to `app/services/` or the owning `app/agent/`
  subsystem.
- Put route coverage in `tests/api/`; use FastAPI dependency overrides instead
  of patching route internals when the dependency seam exists.
- Preserve shapes consumed by `web/src/api/`, queries, and stream stores. API,
  SSE, or WebSocket contract changes require frontend updates and web checks.

## Path and auth safety

- Pass every externally supplied workspace root through
  `team_manager.validate_workspace()` or the existing
  `_validate_workspace_or_422()` wrapper.
- Resolve user/model-supplied paths inside that root with the established
  `_safe_resolve()` / `_safe_join*()` helpers; do not concatenate paths.
- Keep desktop/access-key comparisons constant-time and verify both desktop
  and browser/dev auth flows when changing middleware or dependencies.

The test fixtures clear inherited `OPENAGENTD_DESKTOP_TOKEN` and
`OPENAGENTD_ACCESS_KEY`. Do not bypass that isolation with import-time auth
state.

## Checks

```bash
uv run pytest tests/api -q
uv run ruff check app/api tests/api
uv run ty check app/
make verify-backend
```
