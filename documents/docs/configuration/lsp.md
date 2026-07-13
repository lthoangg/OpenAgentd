---
title: LSP Diagnostics Injection
description: Real-time language-server diagnostics injected into write/edit/patch tool results in coding mode.
status: stable
updated: 2026-07-13
---

# LSP Diagnostics Injection

**Source:** `app/services/lsp/` (`client.py`, `manager.py`), `app/agent/hooks/lsp.py`

In **coding mode**, after the agent uses a `write`, `edit`, or `patch` tool,
OpenAgentd runs the matching language server(s) over the changed file(s) and
appends any errors/warnings to the tool result as a compact `[LSP Diagnostics]`
block. The agent reads that block on its next turn and fixes the problem
immediately — no separate lint/typecheck round-trip.

This only runs in **coding mode** (where the workspace is a real project tree).
Normal/cockpit sessions are untouched. The decision is made once per session at
team-build time (`LspHook(enabled=team.mode == "coding")`) — no per-call DB
lookups.

## On-demand lifecycle

Language servers are **not** started at boot. They are spawned lazily the first
time a file of that language is edited, keyed by `(project_root, language,
command)`:

- **First edit** of a language pays the server cold-start once.
- **Subsequent edits** reuse the warm, cached server.
- **Idle servers** are stopped and reaped after ~5 minutes (a 60-second janitor
  loop also reaps dead processes).
- If no server is found, the language is marked unsupported for a **5-minute
  TTL**, then retried — so installing a server mid-session needs no restart.

## Server selection

Servers are matched to the **project's own toolchain**, not guessed. Resolution
precedence (first tier that yields a command wins):

1. **Project config** — parsed from `pyproject.toml` / `package.json`
   (+ `tsconfig.json`/`jsconfig.json`). A repo that pins `ty` and
   `ruff` gets exactly those.
2. **`settings.yaml`** — a global `lsp:` map, e.g. `lsp: {python: [ty, server]}`.
3. **Built-in defaults** — first installed server from the per-language list.

A command is only used if its executable is found on `PATH`. In the desktop app, OpenAgentd resolves that PATH from your login shell, so servers installed through Homebrew, `uv`, Bun, Cargo, or other user-level toolchains work even when the GUI process starts with a minimal system PATH.

### Python runs multiple servers

Python is the one language where a single server can't cover everything: a type
checker (`ty` / `pyright`) catches type errors but not lint, and `ruff` catches
lint but not types. So for Python, OpenAgentd runs **every installed
complementary server and merges their diagnostics** (`ty` + `ruff`, etc.). The
source is tagged per line (`(ty)`, `(Ruff)`), so overlapping diagnostics stay
traceable.

Every **other** language uses its single canonical server, which already does
syntax + types + lint in one process:

| Language | Default server(s) |
|----------|-------------------|
| Python | `ty` + `ruff` (+ `pyright`/`pylsp` if installed) — merged |
| TypeScript / JavaScript | `typescript-language-server --stdio` |
| Go | `gopls` |
| C / C++ | `clangd` |

## Output format

Diagnostics are filtered to errors (severity 1) and warnings (severity 2),
sorted errors-first, and **capped per file** (default 20) to protect the model's
context window; the overflow is summarised as `…and N more`:

```
[LSP Diagnostics]
- src/main.py:5:25: error: Argument to function `add_numbers` is incorrect: Expected `int`, found `Literal["10"]` (ty)
- src/main.py:1:1: warning: `os` imported but unused (Ruff)
- …and 3 more in src/main.py
```

Multi-file `patch` checks run **concurrently**, and the whole hook is fail-safe:
any LSP error is logged and swallowed — it never crashes the tool. The cockpit
renders this block as a compact, color-coded `ERR` / `WARN` strip beneath the
diff (see [`web/tool-results.md`](../web/tool-results.md)).

## Monorepo / subfolder support

`find_project_root` walks upward from each edited file and stops at the nearest
directory containing a project manifest (`package.json`, `Cargo.toml`,
`pyproject.toml`, etc.), up to the workspace root. This means a monorepo with
separate frontend/backend sub-projects each get their own server instance rooted
at the right sub-project — edits to `frontend/src/App.tsx` talk to a
`typescript-language-server` started at `frontend/`, not the workspace root.

The LSP `initialize` request includes `workspaceFolders` (pointing at the
sub-project root) and advertises the `workspace.workspaceFolders` capability, so
servers like tsserver that gate monorepo / project-reference logic on this
capability behave correctly.

Server startup is serialized per `(project root, language)` rather than
app-wide: concurrent checks for one project reuse a single client, while
unrelated projects can initialize in parallel. Shutdown keeps the response
reader alive through the protocol `shutdown`/`exit` exchange, then terminates
unresponsive servers after the bounded grace period.

## TypeScript: path aliases and bun types

When starting a TypeScript/JavaScript server the manager builds
`initializationOptions` from the project:

- **`tsconfig.json` types** — the `compilerOptions.types` array is forwarded so
  explicitly declared type packages (e.g. `@types/node`) are honoured.
- **Bun projects** — a `bun.lockb` or `bun.lock` in the project root causes
  `bun-types` to be injected into the types list, silencing false-positive errors
  on `bun:test`, `bun:sqlite`, and other built-in Bun modules.

Path aliases (`@/` → `src/`) resolve automatically once tsserver reads the
`tsconfig.json` it is rooted at — no extra configuration needed.

## Caveats (expected LSP behavior, not bugs)

- **Install the server.** No diagnostics appear for a language whose server
  isn't on `PATH`.
- **TypeScript scope.** Strictness/lib behavior follows the nearest
  `tsconfig.json`; loose files use inferred defaults.
- **Type vs. syntax.** Lint-only servers (e.g. `ruff` alone) never report type
  errors — which is exactly why Python runs a type checker alongside.
- **Bun types require `bun-types` on disk.** The injection adds `bun-types` to
  the options passed to tsserver, but the package must actually be installed in
  the project (`bun add -d bun-types`) for the type definitions to resolve.

## Overrides

- Per-project: declare your tooling in `pyproject.toml` / `package.json`.
- Global default: set `lsp:` in `settings.yaml`, e.g.

  ```yaml
  lsp:
    python: [ty, server]
  ```
