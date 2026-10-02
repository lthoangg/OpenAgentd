# Contributing to openagentd

Thanks for your interest in contributing. This guide covers everything you need to get started.

**License note:** openagentd is licensed under [Apache License 2.0](LICENSE). By contributing you agree your work is released under the same license.

All participation must follow the [Code of Conduct](CODE_OF_CONDUCT.md). Issue and PR templates include a short reminder, but not a required checkbox: contributors are expected to follow the policy by participating.

---

## What gets merged

- Bug fixes
- New LLM providers
- Documentation improvements
- Test coverage improvements
- Developer experience improvements

UI changes and new core features require discussion first — open an issue before writing code.

---

## Table of contents

- [Quick start](#quick-start)
- [Project layout](#project-layout)
- [Development workflow](#development-workflow)
- [Change validation policy](#change-validation-policy)
- [Code style](#code-style)
- [Testing](#testing)
- [Submitting changes](#submitting-changes)
- [Issues and roadmap](#issues-and-roadmap)
- [Issue labels](#issue-labels)
- [Code of Conduct and security](#code-of-conduct-and-security)

---

## Quick start

```bash
# 1. Fork + clone
git clone https://github.com/<your-fork>/openagentd.git
cd openagentd

# 2. Install deps
bun install --cwd web

# 3. Start the backend (needs cargo; creates local config and built-in agents)
make run

# 4. (Optional) Start the web UI in a separate terminal
cd web && bun dev
```

`make dev` runs steps 3 and 4 together. The end-of-life v2 Python backend in
`app/` is kept as source-only reference; it has no build, run, or test tooling.

Use Settings to configure providers and `openagentd --help` for the current CLI surface.

---

## Project layout

```
openagentd/
├── appv3/                  # Rust backend (shipped): API, agent runtime, CLI
│   ├── crates/             # core, db, api, agent, tools, providers, cli, …
│   └── contract/           # Data shared with other surfaces (SSE events, …)
├── app/                    # End-of-life v2 FastAPI backend (source only)
│   ├── agent/              # Agent loop, hooks, providers, tools, teams
│   ├── api/                # Routes (thin — logic lives in services/)
│   ├── core/               # Config, DB, middleware, logging
│   ├── models/             # SQLModel DB schemas
│   └── services/           # Business logic, stream_store
├── web/                    # React 19 frontend (Vite + Bun)
├── desktop/, mobile/       # Tauri shells (desktop bundles the appv3 binary)
├── scripts/                # Release, docs, and code-health tools (+ tests/)
├── documents/              # Feature catalogue and assets
│   └── docs/               # Version-cited shipped features
└── .github/                # Issue templates, PR template, CI workflows
```

Skills and agents at runtime live in `{OPENAGENTD_CONFIG_DIR}/agents/` and
`{OPENAGENTD_CONFIG_DIR}/skills/`. Application startup materializes missing
first-party agents from code without overwriting user-owned files.

Key design rules:

- **Route handlers are thin** — durable behavior belongs in the owning runtime
  crate (`appv3/crates/agent/`, `tools/`, `providers/`, `db/`), not in
  `appv3/crates/api/`.

---

## Development workflow

### Change validation policy

Use [`make verify`](Makefile) for the portable pre-merge contract, or its
focused `verify-v3`, `verify-scripts`, `verify-web`, `verify-docs`, and
`verify-version` targets when only one surface changed. Native targets require
local platform dependencies. Check the nearest `AGENTS.md` before changing a
subsystem.

### Backend (v3, Rust)

```bash
make run                                 # start server on :8000
make dev                                 # server + web UI (Vite :5173)
make verify-v3                           # fmt check, clippy -D warnings, tests
cargo test --manifest-path appv3/Cargo.toml -p appv3-api   # one crate
```

### Frontend (web)

```bash
cd web
bun dev                                  # dev server on :5173 (proxies /api → :8000)
bun run lint                             # oxlint (type-aware)
bun run typecheck                        # tsc --noEmit
bun test src/__tests__                   # unit tests
bun run build                            # production build
```

### Database migrations

Migrations run automatically when the server starts — no manual step needed. In a source checkout, `make run` and `make dev` default to the project-local `.openagentd/dev/` paths.

Use `APP_ENV=production` only when you intentionally want to target the installed production database.

---

## Code style

### Rust

- Format with `cargo fmt --all` (see `appv3/rustfmt.toml`); `make verify-v3`
  rejects unformatted code and any clippy warning.

### TypeScript

- Strict TypeScript (`strict: true`).
- Functional React components with explicit prop types.
- TanStack Query for server state, Zustand + Immer for client state.

### General

- **No unnecessary abstractions.** Thin routes, logic in services/hooks.
- Pre-commit hooks enforce formatting automatically — install them once:

  ```bash
  pre-commit install   # install pre-commit first, e.g. `brew install pre-commit` or `pipx install pre-commit`
  ```

---

## Testing

### Backend

Unit tests sit in `#[cfg(test)]` modules beside the code; integration tests
live in `appv3/crates/<crate>/tests/`. Tests that spawn `server serve` use
throw-away `HOME`/XDG roots, so no external services or user data are needed.
Add focused regression coverage for changed behavior where practical.

```bash
make verify-v3                                              # full check
cargo test --manifest-path appv3/Cargo.toml -p appv3-api   # one crate
```

### Frontend

```bash
cd web && bun test src/__tests__         # ~130 ms, no browser needed
```

Tests use Bun test + Happy DOM. Test store logic and pure utils directly; avoid rendering components in unit tests.

---

## Submitting changes

1. **Open an issue first** for anything non-trivial — discuss the approach before writing code.
2. **Branch naming:** `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `refactor/<topic>`.
3. **Before opening a PR:** run the applicable focused checks, then run `make verify`. Run `make verify-native` as well when desktop or mobile Rust code changes and the required native dependencies are available.
4. **Commit style:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
5. **PR description:**

   ```
   ## Changes
   ## Why
   ## Testing
   Fixes #<issue>
   ```

6. Keep PRs focused — one logical change per PR.

---

## Issues and roadmap

Use [Discord](https://discord.gg/cz6GQHQUMg) or the [Facebook Group](https://www.facebook.com/groups/1256361676707935) for community chat, questions, and general discussion.

Use GitHub issues for bugs, known issues, feature requests, and roadmap discussion.
The templates follow the same pattern used by large open-source projects: ask
for reproducible facts, link/remind about conduct and private security reporting,
and avoid mandatory Code of Conduct agreement checkboxes.

GitHub issues are the roadmap; shipped capabilities belong in
[`documents/docs/features.md`](documents/docs/features.md).

- **Bugs / known issues:** use the Bug report template. Confirmed known issues
  are labeled `known issue` by maintainers and stay out of the roadmap page.
- **Features:** use the Feature request template. UI changes and new core
  features need issue discussion before implementation.
- **Roadmap items:** use `roadmap` plus `enhancement`. When a roadmap item ships,
  close the issue and add the shipped feature to `documents/docs/features.md`.
- **Security vulnerabilities:** do not open a public issue. Use GitHub Security
  Advisories as described in [SECURITY.md](SECURITY.md).

## Issue labels

| Label | Meaning |
|-------|---------|
| `bug` | Something is broken |
| `known issue` | Confirmed product issue tracked publicly |
| `enhancement` | New capability or improvement |
| `roadmap` | Planned or considered roadmap item |
| `documentation` | Documentation update |
| `devex` | Developer experience improvement |
| `question` | Usage question (closed after answering) |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention is needed |
| `wontfix` | This will not be worked on |

---

## Code of Conduct and security

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in issues, PRs, commits,
  discussions, and any public representation of the project.
- Keep technical disagreement focused on facts, trade-offs, and user impact.
- Report abuse or harassment through the channels listed in the Code of Conduct.
- Report security vulnerabilities privately through
  [GitHub Security Advisories](https://github.com/lthoangg/openagentd/security/advisories/new).

---

## Documentation

All docs live in `documents/`. Start at [`documents/docs/index.md`](documents/docs/index.md).
