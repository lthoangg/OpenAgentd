# Debug reference: backend (`appv3/`)

Use for API routes, persistence, queueing, SSE streaming, the agent loop, tools,
and providers. `app/` is the frozen v2 Python source; only consult it for the
data formats v3 must keep reading.

## Evidence commands

```bash
make run                                          # API only on :8000 with APP_ENV=development
curl -fsS http://127.0.0.1:8000/api/health/ready  # readiness
agentd server status                          # installed CLI: port, live, ready, LAN
agentd server logs                            # installed CLI: readable log lines
sqlite3 .openagentd/dev/data/openagentd.db '.tables'
```

Log and telemetry analysis: `references/production.md`.

## File map

```
appv3/crates/
  api/        axum routes (src/routes/), middleware (desktop token, Host/Origin guard, CORS), startup, SSE
  agent/      turn loop, hooks (summarization, otel, title), sessions, stream store, scheduler, snapshots
  db/         SQLite pool, v2-compatible queries, migrations
  providers/  provider adapters (openai, anthropic, google, bedrock, copilot, codex, …), plugin providers
  tools/      built-in agent tools (shell, grep, patch, read, …); tool_start/tool_error logging in src/lib.rs
  core/       settings and XDG paths (src/settings.rs), auth policy (src/auth.rs), path safety
  jsplugin/   QuickJS runtime for .ts/.js plugins
  mcp/ memory/ preview/ terminal/   MCP client, memory, Preview tab proxy, PTY terminals
  cli/        the `agentd` binary; `server serve` is the sidecar entry; loguru-format logging (src/logging.rs)
appv3/contract/sse_events.json   SSE event contract shared with web
appv3/REPORT.md                  every deliberate wire or on-disk difference from v2
```

## Failure boundaries

| Boundary | Inspect |
|---|---|
| Route validation | handler in `api/src/routes/`, the HTTP status returned |
| Request parsing | multipart/form fields (CRLF line breaks), `api/src/routes/agent/helpers.rs` (mentions, `#L` line refs) |
| Persistence | `db/` queries and migrations; rows in the dev DB |
| Queueing / ordering | `agent/src/stream_store.rs`, `queue.rs`, SSE emission order |
| Agent loop | `agent/src/agent.rs`, tool dispatch, `hooks/summarization.rs` |
| SSE stream | `agent/src/events.rs`, `api/src/sse.rs`, `appv3/contract/sse_events.json` |
| Provider call | `providers/src/<provider>.rs`, env vars, retry and timeout (`agent/src/retry.rs`) |
| Desktop auth | `core/src/auth.rs`, `api/src/middleware.rs` (`desktop_token`), sidecar handshake |

## Verification

```bash
cargo test --manifest-path appv3/Cargo.toml -p appv3-api --test http_api   # focused
make verify-v3                                                              # fmt, clippy -D warnings, all tests
```

A wire or on-disk format change also needs `make verify-web` and an entry in `appv3/REPORT.md`.
