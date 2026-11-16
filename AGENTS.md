# OpenAgentd Repository Guide

OpenAgentd is a local-first coding-agent cockpit: a native Rust backend
(`appv3/`, v3), one React UI, and separate Tauri desktop and mobile shells.
The canonical catalogue of shipped behavior is `documents/docs/features.md`;
the public website is https://openagentd.dev.

## Ownership

The agent working in this repository owns the code: its structure, its checks,
and its upkeep. The maintainer owns product direction and everything public.

- **Proceed, then show**, when work is local and reversible. Commit your own
  verified changes, one logical change per commit (`oad/commit`). In the files
  a change touches, delete dead code and reshape what is in the way.
- **Ask first** when something is public or irreversible: `git push`, any `gh`
  command that writes (issue, PR, release, comment), a release, signing or
  store submission, a wider auth policy or network guard, and product or UI
  direction (through a plan).
- **Fix or file.** Fix a mistake, friction, or debt you find in its own commit
  when it is small and in files you are already changing. Otherwise add it to
  the backlog. Do not leave it in chat.
- **Encode what repeats.** When the maintainer corrects you, or a mistake
  happens a second time, make it fail a check: first by structure (one source
  of truth), then by a type or lint, then by a test. Write a guide line only
  for a judgment call. Add the rule to the table under Rules and checks, and
  remove a rule once its mistake cannot happen.

The backlog is `.agents/backlog/` in the main checkout: git-ignored, one
Markdown file per item named `<date>-<slug>.md`, with the area, what is wrong,
the evidence, how often it was seen, and what would prove it done. From a
worktree, the main checkout is the first line of `git worktree list`. Read the
backlog when you start work that has no assigned task. An item becomes a
GitHub issue only when the maintainer asks.

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
  The `app_guide` prompt in `appv3/crates/agent/data/builtin_prompts.json`
  tells the agent what the web UI does with a reply.
- `web/`: shared React UI used by browser, desktop, and mobile clients.
- `desktop/`: Tauri shell that supervises the bundled native `agentd`
  sidecar built from `appv3/`.
- `mobile/`: remote-backend-only Tauri shell; it does not bundle a backend.
- `native/shell-core/`: Tauri-free Rust crate shared by both shells (server
  config, URL normalization, access keys, download limits).
- `native/cloud/`: the OpenAgentd Cloud protocol crate (tunnel protocol of
  `appv3/contract/tunnel.md`, device API client, relay), linked by `appv3/`
  and the mobile shell.
- `scripts/`: packaging, release, docs validation, and code-health utilities;
  `scripts/tests/` holds their pytest checks plus installer and workflow
  contracts.
- `documents/`: public feature catalogue and referenced assets.
- `.agents/`: tracked repository commands, snippets, and agent skills (the
  only project folder OpenAgentd reads); `.agents/plans/` and
  `.agents/backlog/` are ignored.
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
make dev PORT=8001 WEB_PORT=5174   # a second checkout or worktree beside the first
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
  validator (`validate_workspace` in `appv3/crates/agent/src/manager.rs`).
  Resolve paths within a workspace with the existing `safe_resolve` /
  `safe_join` helpers.
- Preserve constant-time secret comparison (`auth::constant_time_eq`).
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
  design mobile-first, and preserve touch/pointer parity. Check a UI change on
  the running app at a phone width and a desktop width with `oad/drive`, and
  look at the screenshots it saves.

## Validation

`make verify-changed` runs every target below that covers the paths changed
since the upstream branch (`python3 scripts/verify_changed.py --list` prints
them without running). The targets:

```bash
make verify-changed # verify-quick, then the targets the changed paths select
make verify-quick   # seconds: Tauri command ACL, secret scan, docs, versions, cargo fmt, web lint + types
make verify-v3       # v3 Rust: cargo fmt check, clippy -D warnings, tests
make verify-scripts  # pytest for scripts, installers, and workflow contracts (local .venv)
make verify-web      # oxlint, app/test TypeScript (tsc -b), Bun tests
make verify-docs     # Markdown links/frontmatter/Make references
make verify-version  # synchronized release versions and catalogue metadata
make verify-desktop  # command ACL, locked desktop cargo check/test/clippy
make verify-mobile   # command ACL, locked mobile cargo check and clippy -D warnings
make verify-shell-core # shared native crate fmt/clippy/test
make verify-cloud    # OpenAgentd Cloud protocol crate fmt/clippy/test
make verify          # portable v3 + scripts + web + docs + version checks
make verify-native   # shell-core + desktop + mobile; native system dependencies required
```

Use focused checks while iterating, then run the applicable target above.
A change is checked by every surface that compiles or reads it, not only the
one it lives in; the path table in `scripts/verify_changed.py` is the list,
and a test fails when a CI workflow is not triggered by a path in it.
Always run Bun tests with `--parallel` (`bun test --cwd web --parallel` or `cd web && bun test --parallel <path>`) for per-file module isolation.
Cross-surface API or event changes require both backend and web checks; SSE
event types must also match `appv3/crates/agent/data/sse_events.json`. Run
`make help` for maintained health and build targets.
A UI change that alters what the agent should write in a reply (something a
reply can now render, open, or run, or no longer can) updates `app_guide` in
the same commit. It is the only prompt text that describes the app: do not
repeat any of it in another prompt or a tool description.
CI additionally runs `bun run build` for `web/`, which enforces the bundle
budget and chunk-cycle checks. `pre-commit install` sets up two hooks: at
commit, file hygiene plus `oxlint` and `tsc` for `web/src`; at push,
`make verify-quick`.

## Rules and checks

Each rule names what fails when it is broken. "Judgment" means nothing fails:
the rule depends on you reading it, for the reason given.

| Rule | Check |
|---|---|
| A crate depends only on lower layers | `appv3/crates/cli/tests/crate_layers.rs` |
| No `dbg!`, `todo!`, `unimplemented!` in Rust | `[workspace.lints]` in `appv3/Cargo.toml`, clippy `-D warnings` |
| Every published SSE event is listed in `sse_events.json` | `appv3/crates/agent/src/events.rs` (debug builds), `web/src/__tests__/api/sse-contract.test.ts` |
| `app_guide` is the only text that describes the app | `appv3/crates/agent/tests/runtime_protocol.rs`, `web/src/__tests__/api/app-guide-contract.test.tsx` |
| The network guard refuses foreign hosts and origins | tests in `appv3/crates/api/src/middleware.rs` |
| Child processes do not inherit secrets | `appv3/crates/core/tests/child_env.rs` |
| `fetch` only in `web/src/api/`; no `any`; no conditional hook; no import cycle | `bun run lint` (`web/.oxlintrc.json`) |
| `web/src/components/ui/` imports no class or component library | `bun run lint` (`no-restricted-imports`) |
| Design and copy rules that can be read from source | `web/src/__tests__/design-lint.test.ts`, `copy-lint.test.ts`, `web/src/__tests__/styles/` |
| A Tauri command is registered, allowed, and called | `scripts/check_tauri_commands.py` |
| No secret-shaped value in a tracked file | `scripts/check_no_secrets.py` |
| Release versions agree everywhere | `make verify-version` |
| Build jobs hold no signing secret | `scripts/tests/test_release_signing_isolation.py` |
| CI runs a gate when a path it covers changes | `scripts/tests/test_verify_changed.py` |
| Markdown links, `make` targets, and guide paths exist | `make verify-docs` |
| Workspace roots go through `validate_workspace` | Judgment: a raw path still compiles (backlog: a workspace type) |
| Secrets are compared in constant time | Judgment: no lint can tell a secret from another string |
| Subprocesses take argument lists | Judgment: review of each new `Command` |
| Route handlers stay thin | Judgment: a matter of degree |
| A wire or on-disk change is recorded in `appv3/REPORT.md` | Judgment: only a person knows a change is a wire change |
| A shipped user-visible change is in the feature catalogue | Judgment: `make verify-version` checks only the release line |
| Bun tests run with `--parallel` | Judgment: the package scripts pass it; a bare `bun test` does not fail |
| A UI change works at a phone width and a desktop width | `oad/drive` journeys (run on demand; they need a built backend, so no `make verify` target runs them) |

## Agent workflows

Repository workflows live in `.agents/skills/oad/`: `oad/testing`
(test-first and per-surface commands), `oad/drive` (drive the running app at a
phone and a desktop width and keep the proof), `oad/debug` (including logs
and telemetry), `oad/review`, `oad/commit` (including the documentation
pass), `oad/release`, and `oad/ios-store` (TestFlight and App Store).

## Documentation

- Update `documents/docs/features.md` for shipped user-visible behavior. Tag an
  entry with the release it will ship in: the next version, not the one
  `scripts/release_version.sh` prints. Keep entries factual. This is the one
  statement of the rule; `oad/commit` step 3 says where each other kind of
  change is recorded.
- Update `README.md` only when setup or the user-facing product story changes.
- Read `SECURITY.md` for vulnerability reporting and `CONTRIBUTING.md` for PR
  policy. Keep implementation rationale near the relevant code/tests rather
  than expanding the public feature catalogue.
