# Debug reference: Backend / API / agent / provider

Use when the symptom is in API routes, persistence, queueing, SSE streaming, agent loops, tool execution, or provider calls.

---

## Evidence commands

Start with no-server diagnostics, then live ones:

```bash
uv run python -m manual.backend_log              # scan app.log for WARNING/ERROR (no server needed)
uv run python -m manual.health                   # server liveness + agent roster
uv run python -m manual.team_history <SESSION_ID>
uv run python -m manual.team_timeline <SESSION_ID> --full
uv run python -m manual.team_sse "message" --session <SESSION_ID>
```

See `manual/AGENTS.md` for the full catalogue — every script supports `-h`.

Provider smoke tests:

```bash
uv run python -m manual.try_providers.<provider>  # e.g. manual.try_providers.anthropic
```

---

## File map

```
app/
  server.py            FastAPI app entry, route registration
  api/                 Route handlers (sessions, agents, messages, tools, …)
  core/                Business logic, agent runner, session manager
  core/desktop_auth.py Desktop token validation
  providers/           LLM provider adapters
  db/                  SQLModel models, migrations, session factories
manual/                Diagnostic scripts (no prod impact)
tests/                 pytest coverage — match test to the layer you changed
```

---

## Common failure boundaries

| Boundary | What to inspect |
|---|---|
| Route validation | Pydantic schema, FastAPI dependency, HTTP status returned |
| Persistence | SQLModel model, Alembic migration, `db/` session factory |
| Queueing / ordering | Message queue in `core/`, SSE event emission order |
| Agent loop | `core/` agent runner, tool dispatch, compaction logic |
| SSE stream | `api/` stream route, `Emitter`, client reconnect behavior |
| Provider call | `providers/` adapter, env vars, retry/timeout config |
| Desktop auth | `core/desktop_auth.py`, token header, sidecar handshake |

---

## Verification

```bash
uv run pytest tests/ -x -q                      # full suite, stop on first fail
uv run pytest tests/path/to/test.py -x -v       # focused
uv run ruff check app/ && uv run ruff format --check app/
uv run ty check app/
```
