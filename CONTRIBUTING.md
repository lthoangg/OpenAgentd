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
uv sync
bun install --cwd web

# 3. First-time setup (provider, API key, config files)
openagentd init

# 4. Start the backend
make run

# 5. (Optional) Start the web UI in a separate terminal
cd web && bun dev
```

Use `openagentd init`, Settings, and `openagentd --help` for the current setup and configuration surface.

---

## Project layout

```
openagentd/
├── app/                    # FastAPI backend
│   ├── agent/              # Agent loop, hooks, providers, tools, teams
│   ├── api/                # Routes (thin — logic lives in services/)
│   ├── core/               # Config, DB, middleware, logging
│   ├── models/             # SQLModel DB schemas
│   └── services/           # Business logic, stream_store
├── web/                    # React 19 frontend (Vite + Bun)
├── tests/                  # pytest test suite
├── seed/                   # Default config copied on first init
│   ├── agents/             # Default global/coding agent descriptors
│   └── mcp.json            # Empty default MCP server config
├── documents/              # Feature catalogue, decision records, and assets
│   ├── docs/               # Version-cited shipped features
│   └── adrs/               # Significant architecture/security decisions
└── .github/                # Issue templates, PR template, CI workflows
```

Skills and agents at runtime live in `{OPENAGENTD_CONFIG_DIR}/agents/` and `{OPENAGENTD_CONFIG_DIR}/skills/` (populated from `seed/` on first `openagentd init`).

Key design rules:

- **Route handlers are thin** — business logic belongs in `services/`.
- **All agent code lives under `app/agent/`** — never scatter into top-level packages.
- **`stream_store.init_turn()` is called synchronously** before the background task starts — no producer/consumer race.

---

## Development workflow

### Change validation policy

Use [`make verify`](Makefile) for the portable pre-merge contract, or its
focused `verify-backend`, `verify-web`, `verify-docs`, and `verify-version`
targets when only one surface changed. Native targets require local platform
dependencies. Check the nearest `AGENTS.md` before changing a subsystem.

### Backend

```bash
uv sync                                  # install / sync Python deps
make run                                 # start server on :8000
make dev                                 # with auto-reload

uv run ruff check app/ tests/            # lint
uv run ruff check app/ tests/ --fix      # auto-fix
uv run ruff format app/ tests/           # format
uv run ty check app/                     # type check

uv run pytest -n auto -q                 # fast tests (default: no coverage)
make coverage                            # full run with coverage (htmlcov/)
```

### Frontend (web)

```bash
cd web
bun dev                                  # dev server on :5173 (proxies /api → :8000)
bun run lint                             # eslint
bun run typecheck                        # tsc --noEmit
bun test src/__tests__                   # unit tests
bun run build                            # production build
```

### Database migrations

Migrations run automatically when the server starts — no manual step needed. In a source checkout, development now defaults to the project-local `.openagentd/dev/` paths, so the provided `make` command is enough:

```bash
# Recommended:
make migrate

# Or manually:
uv run alembic -c app/alembic.ini upgrade head
```

Use `APP_ENV=production` only when you intentionally want to target the installed production database.

---

## Code style

### Python

- **Python 3.14+** — use `|` for unions, `from __future__ import annotations` in every file.
- Strict type hints on all function signatures.
- Pydantic v2 for all data models (`ConfigDict(extra="ignore")` for external responses).
- `snake_case` for modules/functions/variables, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants.
- Logging with **loguru**: `logger.info("event_name key={} key2={}", val, val2)`.
- Absolute imports from `app` (e.g. `from app.agent.schemas.chat import ChatMessage`).

### TypeScript

- Strict TypeScript (`strict: true`).
- Functional React components with explicit prop types.
- TanStack Query for server state, Zustand + Immer for client state.

### General

- **No unnecessary abstractions.** Thin routes, logic in services/hooks.
- Pre-commit hooks enforce formatting automatically — install them once:

  ```bash
  uv run pre-commit install
  ```

---

## Testing

### Backend

Tests mirror the `app/` structure under `tests/`. Key patterns:

- `conftest.py` redirects to in-memory SQLite — no external DB needed.
- In-memory SQLite and `AsyncMock` for all external dependencies — no external services needed in unit tests.
- `app.dependency_overrides` for FastAPI dependency injection.

Coverage aspiration: aim for **≥ 80%** for `app/agent/` and `app/api/`; this is a
quality goal, **not a CI-enforced merge gate**. Add focused regression coverage
for changed behavior where practical.

```bash
uv run pytest -n auto -q                 # quick pass/fail
make coverage                            # full with HTML coverage report
open htmlcov/index.html
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
