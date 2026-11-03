# Rust Backend (v3) Guide

`appv3/` is the native `agentd` backend. It ships as the CLI release
binary and as the desktop sidecar (`desktop/sidecar-bundle/bin/agentd`).
It reads the database and config files of the end-of-life Python v2 backend,
whose source is no longer in this tree. Its HTTP/SSE/WebSocket API started as
v2's and now differs where `REPORT.md` says.

## Crate map

- `core`: settings, XDG paths, auth policy (`auth.rs`), path safety
  (`security.rs`), errors, platform plumbing (`which`, `home`, `proctree`).
- `db`: SQLite pool, queries (reading v2-era rows too), and the replayed
  Alembic chain.
- `kernel`: module lifecycle (start in dependency order, stop in reverse,
  per-module state) and typed contributions tagged with their module.
- `api`: axum routes, middleware (auth, Origin/Host guard, CORS, panic → 500),
  startup/shutdown through the kernel (`modules.rs`, `plugins.rs`).
- `agent`: turn loop, hooks, sessions, SSE broadcaster and stream store,
  snapshots, scheduler.
- `providers`, `tools`, `mcp`, `memory`, `terminal`, `jsplugin`, `plugins`:
  the model providers, built-in tools, MCP client, memory pages, PTY
  terminal, the QuickJS plugin host, and the plugin folder reader
  (manifest, skills, MCP servers, permissions).
- `cli`: the `agentd` binary (`server serve` is the sidecar entry point).
- `crates/*/data/`: data each crate compiles in (tool definitions, prompts,
  the provider catalog, built-in skills and commands, MIME types).
  `crates/agent/data/sse_events.json` lists every SSE event type per stream
  and is shared with the web client. Rust checks each published event against
  it (`agent/src/events.rs`; debug builds panic), and
  `web/src/__tests__/api/sse-contract.test.ts` checks the web unions. A new
  event needs the JSON entry, the Rust producer, and the web type/handler.

## Modules

Every service the server starts is a kernel module; `GET /api/modules` and
`agentd doctor` show their state.

- Built-in modules are the `BUILTIN` table in `api/src/modules.rs`. Start order
  is dependency order, then table order; stop order is the reverse, and
  `builtin_modules_stop_in_the_servers_shutdown_order` pins it. Place a new
  entry where its stop belongs, and update that test only for a deliberate
  change.
- `deps` lists hard requirements only: a module whose dependency failed is
  blocked. Mark a module `critical` only when the server must not run
  without it; any other failure leaves the rest running.
- A module hands out what it provides in `register` (`Registrar::add`, no
  I/O there), and consumers read it with `Kernel::contributions::<C>()`.
  Contributions are removed when their module stops, so restarting one
  replaces them (examples: `agent::plugins::ExtraTool`,
  `agent::skills::PluginSkills`, `mcp::plugin::PluginServers`).
- Each plugin folder is a `plugin:<name>` module added by
  `api::plugins::reload()`. Start and stop hooks must not call kernel
  operations (`add`, `restart`, `remove`).
- Test a module by booting a `Kernel::new()` with only the modules it needs
  (`kernel/src/tests.rs`).

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
