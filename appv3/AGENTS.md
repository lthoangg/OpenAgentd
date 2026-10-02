# Rust Backend (v3) Guide

`appv3/` is the native `openagentd` backend. It ships as the CLI release
binary and as the desktop sidecar (`desktop/sidecar-bundle/bin/openagentd`).
It serves the same HTTP/SSE/WebSocket API as the end-of-life Python backend
in `app/` and shares its database and config files. `REPORT.md` records the
deliberate differences from v2.

## Crate map

- `core`: settings, XDG paths, auth policy (`auth.rs`), path safety
  (`security.rs`), errors, platform plumbing (`which`, `home`, `proctree`).
- `db`: SQLite pool, v2-compatible queries, and the replayed Alembic chain.
- `api`: axum routes, middleware (auth, Origin/Host guard, CORS, panic → 500),
  startup/shutdown.
- `agent`: turn loop, hooks, sessions, SSE broadcaster and stream store,
  snapshots, scheduler.
- `providers`, `tools`, `mcp`, `memory`, `terminal`, `jsplugin`: the model
  providers, built-in tools, MCP client, memory pages, PTY terminal, and
  the QuickJS plugin host.
- `cli`: the `openagentd` binary (`server serve` is the sidecar entry point).
- `tui`: `openagentd tui`, a terminal client of the HTTP/SSE API (no
  backend crates; the `cli` crate finds or starts the server for it).
- `contract/`: data shared with other surfaces. `sse_events.json` lists
  every SSE event type per stream. Rust checks each published event against
  it (`agent/src/events.rs`; debug builds panic), and
  `web/src/__tests__/api/sse-contract.test.ts` checks the web unions. A new
  event needs the JSON entry, the Rust producer, and the web type/handler.

## Safety constraints

- Validate externally supplied workspace roots with
  `agent::manager::validate_workspace` (routes: `validate_workspace_or_422`)
  and resolve paths inside them with the existing `safe_join` /
  `safe_resolve` route helpers. Do not join untrusted paths by hand.
- Compare secrets with `core::auth::constant_time_eq`.
- The network guard in `api/src/middleware.rs` refuses foreign `Host`
  headers and cross-origin callers when no access key is set. Do not widen
  it, the auth exempt paths, or the CORS default without explicit approval.
- `server serve` removes `core::auth::CHILD_ENV_SECRETS` from its own
  environment at startup, so no child process (shell tool, terminal, git,
  MCP, plugins) inherits the desktop token or access key. Add any new
  secret that arrives via the environment to that list.
- Spawn processes with argument lists (`Command::new(..).args(..)`), apply
  `proctree::hide_window`, and kill process trees through `proctree`.
- A panic inside a turn becomes an ordinary turn error, and a handler panic
  becomes a plain 500. Treat both as bugs, not error handling: return errors.

## Checks

From the repository root:

```bash
make verify-v3   # cargo fmt --check, clippy -D warnings, all tests
```

While iterating, run `cargo fmt --all` (see `rustfmt.toml`) and focused
crates, e.g. `cargo test -p appv3-api`, from this directory. Integration
tests that spawn `server serve` (`crates/cli/tests/`) build the binary and
use throw-away `HOME`/XDG roots; never point tests at real user data.
API or event changes also need `make verify-web`.
