# OpenAgentd Repository Guide

OpenAgentd is a local-first coding-agent cockpit: a native Rust backend
(`appv3/`, v3), one React UI, and separate Tauri desktop and mobile shells.
The canonical catalogue of shipped behavior is `documents/docs/features.md`;
the public website is https://openagentd.dev.

## Instruction scopes

Apply this file repository-wide, then add the nearest nested `AGENTS.md` for
the path you edit. The main local guides are:

- Backend v3 (shipped): `appv3/AGENTS.md`.
- Frontend: `web/AGENTS.md` and `web/src/AGENTS.md`.
- Native shells: `desktop/AGENTS.md`, `desktop/src-tauri/AGENTS.md`,
  `mobile/AGENTS.md`, `mobile/src-tauri/AGENTS.md`, and
  `native/shell-core/AGENTS.md`.
- Maintainer assets: `scripts/AGENTS.md`, `.agents/AGENTS.md`,
  `documents/AGENTS.md`, and `documents/docs/AGENTS.md`.

Ignored copies under build outputs, `node_modules/`, `.openagentd/dev/`, or
worktrees are not part of the tracked instruction hierarchy.

## Repository map

- `appv3/`: the shipped backend: Rust workspace for the API, agent runtime,
  CLI, scheduler, persistence, and the desktop sidecar binary.
  Each crate's `data/` folder holds the data it compiles in; the SSE event
  list in `appv3/crates/agent/data/sse_events.json` is shared with the web.
- `web/`: shared React UI used by browser, desktop, and mobile clients.
- `desktop/`: Tauri shell that supervises the bundled native `agentd`
  sidecar built from `appv3/`.
- `mobile/`: remote-backend-only Tauri shell; it does not bundle a backend.
- `native/shell-core/`: Tauri-free Rust crate shared by both shells (server
  config, URL normalization, access keys, download limits).
- `scripts/`: packaging, release, docs validation, and code-health utilities;
  `scripts/tests/` holds their pytest checks plus installer and workflow
  contracts.
- `documents/`: public feature catalogue and referenced assets.
- `.agents/`: tracked repository commands, snippets, and agent skills (the
  only project folder OpenAgentd reads); `.agents/plans/` is ignored.
- `.openagentd/`: ignored local runtime state (`dev/` and older plans and
  sessions); not source.

## Setup and development

Prerequisites: Bun (CI uses 1.4.0), stable Rust/cargo, `python3` (maintainer
scripts only), and `lsof` + `nc` for `make dev`. Native shells also need
`cargo tauri` (tauri-cli 2) and the platform's Tauri system dependencies.

From the repository root:

```bash
bun install --cwd web --frozen-lockfile
make run       # v3 API only on :8000
make dev       # v3 API + Vite on :5173
```

Source checkouts run in development (debug builds default to it, and
`make run`/`make dev` pin `OPENAGENTD_ENV=development`), so the database, config,
logs, and telemetry live under the ignored `.openagentd/dev/` tree, never in
the user's installed app state.

Build outputs have distinct targets:

```bash
make build-v3    # optimized v3 release binary
make build-web   # web/dist for native packaging
```

Use the native subtree Makefiles for desktop/mobile packages
(`make -C desktop sidecar` stages the v3 binary).

## Architecture boundaries

- Keep route handlers (axum in `appv3/crates/api/`) focused on transport
  validation and response shaping. Durable behavior belongs in the owning
  runtime crate (`appv3/crates/agent/`, `tools/`, `providers/`, `db/`).
- v2 format parity is not a goal. v3 may change its wire and on-disk
  formats (JSON spacing, field order, Python-style renderings) when the web
  client changes in the same commit, but it must keep reading data that v2
  installs wrote (DB schema and rows, YAML configs and frontmatter, snapshot
  repos). Record every wire or on-disk change in `appv3/REPORT.md`.
- In the UI, TanStack Query owns server state and Zustand owns client/stream
  state. Keep backend wire handling in `web/src/api/`, queries in
  `web/src/queries/`, and route registration in `web/src/router.ts`.
- The same `web/` code runs in browsers and both Tauri shells. Desktop-only or
  mobile-only behavior must be gated through existing platform hooks/bridges.
- Desktop may launch a sidecar; mobile always connects to an existing API.
  Preserve this distinction when changing connection or authentication flows.

## Safety constraints

- Route every externally supplied workspace root through the workspace
  validator (v3: `validate_workspace` in `appv3/crates/agent/src/manager.rs`;
  v2: `app.services.agent_manager.validate_workspace()`). Resolve paths within
  a workspace with the existing `safe_resolve` / `safe_join` helpers.
- Preserve constant-time secret comparison (v3: `auth::constant_time_eq`; v2:
  `hmac.compare_digest`).
- Keep the v3 network guard (Host check, cross-origin refusal without an
  access key) and the child-environment secret scrub in `appv3/crates/core/`
  and `appv3/crates/api/` intact; see `appv3/AGENTS.md`.
- Treat auth, shell/file tools, MCP launch configuration, Tauri CSP/
  capabilities, secret storage (desktop key files, mobile keyring), and updater/signing code as
  security-sensitive. Use argument-list subprocess APIs; do not introduce
  `shell=True` command construction.
- Do not edit generated/build state such as `web/dist/`,
  `desktop/sidecar-bundle/`, native `target/` (including `appv3/target/`) or
  `gen/` trees, ignored `.openagentd/` runtime state, or `.agents/plans/`. Change sources and
  rerun the owning build.
- Keep release versions synchronized through the repository release scripts;
  `make verify-version` checks the cross-project contract.
- Read `DESIGN.md` before changing UI. Use its tokens and existing primitives,
  design mobile-first, preserve touch/pointer parity, and manually inspect both
  narrow and wide layouts for visual changes.

## Validation

Choose every target covering the paths changed:

```bash
make verify-v3       # v3 Rust: cargo fmt check, clippy -D warnings, tests
make verify-scripts  # pytest for scripts, installers, and workflow contracts (local .venv)
make verify-web      # oxlint, app/test TypeScript (tsc -b), Bun tests
make verify-docs     # Markdown links/frontmatter/Make references
make verify-version  # synchronized release versions and catalogue metadata
make verify-desktop  # locked desktop cargo check/test/clippy
make verify-mobile   # locked mobile cargo check
make verify-shell-core # shared native crate fmt/clippy/test
make verify          # portable v3 + scripts + web + docs + version checks
make verify-native   # shell-core + desktop + mobile; native system dependencies required
```

Use focused checks while iterating, then run the applicable target above.
Always run Bun tests with `--parallel` (`bun test --cwd web --parallel` or `cd web && bun test --parallel <path>`) for per-file module isolation.
Cross-surface API or event changes require both backend and web checks; SSE
event types must also match `appv3/crates/agent/data/sse_events.json`. Run
`make help` for maintained health and build targets.
CI additionally runs `bun run build` for `web/`, which enforces the bundle
budget and chunk-cycle checks. Pre-commit hooks run file hygiene plus `oxlint`
and `tsc` for `web/src`.

## Agent workflows

Repository workflows live in `.agents/skills/oad/`: `oad/testing`
(test-first and per-surface commands), `oad/debug` (including logs and
telemetry), `oad/review`, `oad/commit` (including the documentation pass),
and `oad/release`.

## Documentation

- Update `documents/docs/features.md` for shipped user-visible behavior; use
  the current version tag and keep entries factual.
- Update `README.md` only when setup or the user-facing product story changes.
- Read `SECURITY.md` for vulnerability reporting and `CONTRIBUTING.md` for PR
  policy. Keep implementation rationale near the relevant code/tests rather
  than expanding the public feature catalogue.
