# OpenAgentd Repository Guide

OpenAgentd is a local-first coding-agent cockpit: a FastAPI backend, one React UI,
and separate Tauri desktop and mobile shells. The canonical catalogue of
shipped behavior is `documents/docs/features.md`.

## Instruction scopes

Apply this file repository-wide, then add the nearest nested `AGENTS.md` for
the path you edit. The main local guides are:

- Backend: `app/AGENTS.md`, plus `app/agent/AGENTS.md`, `app/api/AGENTS.md`, or
  `app/services/AGENTS.md`.
- Frontend: `web/AGENTS.md` and `web/src/AGENTS.md`.
- Native shells: `desktop/AGENTS.md`, `desktop/src-tauri/AGENTS.md`,
  `mobile/AGENTS.md`, and `mobile/src-tauri/AGENTS.md`.
- Tests and diagnostics: `tests/AGENTS.md`, `tests/manual/AGENTS.md`, and
  `manual/AGENTS.md`.
- Maintainer assets: `scripts/AGENTS.md`, `.openagentd/AGENTS.md`,
  `documents/AGENTS.md`, `documents/docs/AGENTS.md`, and
  `experiments/turbovec_docs/AGENTS.md`.

Ignored copies under build outputs, `node_modules/`, `.openagentd/dev/`, or
worktrees are not part of the tracked instruction hierarchy.

## Repository map

- `app/`: API, agent runtime, CLI, scheduler, SQLModel tables, migrations, and
  application services.
- `web/`: shared React UI used by browser, desktop, and mobile clients.
- `desktop/`: Tauri shell that can supervise a bundled Python sidecar.
- `mobile/`: remote-backend-only Tauri shell; it does not bundle Python.
- `tests/`: pytest suite mirroring `app/`; `tests/manual/` holds standalone
  service scenarios.
- `manual/`: live-server and provider smoke/debug scripts.
- `scripts/`: packaging, release, docs validation, and code-health utilities.
- `documents/`: public feature catalogue and referenced assets.
- `.openagentd/`: tracked repository commands, snippets, and agent skills;
  runtime state beneath ignored subdirectories is not source.
- `experiments/turbovec_docs/`: isolated semantic-search experiment; it is not
  imported by the product or shipped in release builds.

## Setup and development

From the repository root:

```bash
uv sync --frozen
bun install --cwd web --frozen-lockfile
make run       # API only on :8000
make dev       # API with reload + Vite on :5173
```

Build outputs have distinct targets:

```bash
make build       # Python wheel only
make build-web   # web/dist for native packaging
```

Use the native subtree Makefiles for desktop/mobile packages; do not treat the
Python wheel as a native application build.

## Architecture boundaries

- Keep FastAPI handlers focused on transport validation and response shaping.
  Durable behavior belongs in `app/services/` or the owning `app/agent/`
  subsystem; persistence tables belong in `app/models/` or scheduler models.
- Keep provider/tool/agent runtime behavior under `app/agent/`; do not move it
  into route modules.
- In the UI, TanStack Query owns server state and Zustand owns client/stream
  state. Keep backend wire handling in `web/src/api/`, queries in
  `web/src/queries/`, and route registration in `web/src/router.ts`.
- The same `web/` code runs in browsers and both Tauri shells. Desktop-only or
  mobile-only behavior must be gated through existing platform hooks/bridges.
- Desktop may launch a sidecar; mobile always connects to an existing API.
  Preserve this distinction when changing connection or authentication flows.

## Safety constraints

- Route every externally supplied workspace root through
  `app.services.agent_manager.validate_workspace()`. Resolve paths within a
  workspace with the existing `_safe_resolve()` / `_safe_join*()` helpers.
- Preserve constant-time secret comparison with `hmac.compare_digest`.
- Treat auth, shell/file tools, MCP launch configuration, Tauri CSP/
  capabilities, keyring storage, and updater/signing code as
  security-sensitive. Use argument-list subprocess APIs; do not introduce
  `shell=True` command construction.
- Do not edit generated/build state such as `web/dist/`, `app/_web_dist/`,
  `desktop/sidecar-bundle/`, native `target/` or `gen/` trees, or ignored
  `.openagentd/` runtime state. Change sources and rerun the owning build.
- Keep release versions synchronized through the repository release scripts;
  `make verify-version` checks the cross-project contract.
- Read `DESIGN.md` before changing UI. Use its tokens and existing primitives,
  design mobile-first, preserve touch/pointer parity, and manually inspect both
  narrow and wide layouts for visual changes.

## Validation

Choose every target covering the paths changed:

```bash
make verify-backend  # ruff lint/format check, ty, pytest
make verify-web      # ESLint, app/test TypeScript, Bun tests
make verify-docs     # Markdown links/frontmatter/Make references
make verify-version  # synchronized release versions and catalogue metadata
make verify-desktop  # locked desktop cargo check/test/clippy
make verify-mobile   # locked mobile cargo check
make verify          # portable backend + web + docs + version checks
make verify-native   # desktop + mobile; native system dependencies required
```

Use focused checks while iterating, then run the applicable target above.
Cross-surface API or event changes require both backend and web checks. Run
`make help` for maintained scenario, health, migration, and build targets.

## Documentation

- Update `documents/docs/features.md` for shipped user-visible behavior; use
  the current version tag and keep entries factual.
- Update `README.md` only when setup or the user-facing product story changes.
- Read `SECURITY.md` for vulnerability reporting and `CONTRIBUTING.md` for PR
  policy. Keep implementation rationale near the relevant code/tests rather
  than expanding the public feature catalogue.
