# Rust Backend (v3) Guide

`appv3/` is the native `agentd` backend. It ships as the CLI release
binary and as the desktop sidecar (`desktop/sidecar-bundle/bin/agentd`).
It reads the database and config files of the end-of-life Python v2 backend,
whose source is no longer in this tree. Its HTTP/SSE/WebSocket API started as
v2's and now differs where `REPORT.md` says. `REPORT.md` is an index; record a
wire or on-disk change at the top of `report/changes.md`.

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
- Layers, lowest first: `core`/`kernel`/`plugins` → `db`/`memory`/`jsplugin`
  → `providers` → `tools` → `terminal`/`preview` → `agent` → `mcp` → `api`
  → `cli`. A crate depends only on lower layers;
  `cli/tests/crate_layers.rs` enforces it and lists where a new crate goes.
- `crates/*/data/`: data each crate compiles in (tool definitions, prompts,
  the provider catalog, built-in skills and commands, MIME types).
  `crates/agent/data/sse_events.json` lists every SSE event type per stream
  and is shared with the web client. Rust checks each published event against
  it (`agent/src/events.rs`; debug builds panic), and
  `web/src/__tests__/api/sse-contract.test.ts` checks the web unions. A new
  event needs the JSON entry, the Rust producer, and the web type/handler.
  `app_guide` in `crates/agent/data/builtin_prompts.json` is the one place a
  lead agent learns what the app does with a reply. The runtime appends it
  (`RuntimeProtocolHook`); `agent/tests/runtime_protocol.rs` fails when
  another prompt or tool description repeats it, and
  `web/src/__tests__/api/app-guide-contract.test.tsx` renders each thing it
  promises. After editing it, rewrite the request snapshot
  (`agent/tests/request_snapshot.rs`).

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

## State machines

A lifecycle (a session's turn, a scheduled task, a goal, a member, a
connection, an update) is a state machine, written out rather than spread
over flags, `Option`s and status strings.

- **Shape.** An enum of states with each state's data inside its variant, an
  enum of events, and `impl appv3_core::machine::Machine`: `TRANSITIONS` is
  the written table of `(from, event, to)` kinds, `step` decides the next
  state and is pure. Keep the state field private to the machine's module,
  so nothing else can write it. `grep -rn "impl Machine for" crates` lists
  them all.
- **Moves.** `machine::apply` makes a move that must be legal: one outside
  the table keeps the state, logs `illegal_transition`, and panics in debug
  builds. Call `step` directly where a refusal is an ordinary answer (a busy
  session refusing a second turn); check and move under one lock.
- **Wire and disk.** The status string the API, SSE or a database column
  carries is derived from the variant (`as_str`), never stored beside it. A
  status column accepts only the values in `db::migrations::STATUS_VALUES`
  (triggers from migration 00000034; add a column's list there and a
  migration when you add a machine that stores one), and the machine tests
  its states against that list. The session states the web reads are
  `crates/agent/data/session_states.json`.
- **A row-backed machine.** When the state lives in a database row's columns
  (`scheduler/state.rs`, `goal/state.rs`), `TaskState::of(row)` reads it and
  one `transition(row, event)` writes every column it encodes; a test in the
  module scans its callers' source for any other write to those columns.
  A table whose event's data picks the target writes `a|b` in the row and
  checks it as the scheduler's test does.
- **Test it** with `machine::check_table` over a sample of every state and
  event, a test per illegal move that matters, and a race test where two
  callers can move it at once.

## Checks

From the repository root:

```bash
make verify-v3   # cargo fmt --check, clippy -D warnings, all tests
```

The tests run under `cargo nextest` (install it once: `cargo install
cargo-nextest --locked`), here and in CI: every test in its own process, and
the tests of all binaries in parallel. A test may therefore set process-wide
state, but it must not need another test to have run, and it shares the
machine with every other test while it runs.

Every crate opts into `[workspace.lints]` in `Cargo.toml` (`dbg!`, `todo!`,
`unimplemented!` are denied); a new crate adds `[lints] workspace = true`.

While iterating, run `cargo fmt --all` (see `rustfmt.toml`) and focused
crates, e.g. `cargo test -p appv3-api`, from this directory. Integration
tests that spawn `server serve` (`crates/cli/tests/`) build the binary and
use throw-away `HOME`/XDG roots; never point tests at real user data.
API or event changes also need `make verify-web`.
