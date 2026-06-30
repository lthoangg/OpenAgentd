---
title: Configuration
description: Hub for environment variables, paths, agent files, providers, tools, skills, sandbox, and hooks.
status: stable
updated: 2026-05-16
---

# Configuration

Everything you need to customise OpenAgentd. The detailed reference is split across the [`configuration/`](./configuration/) subfolder to keep each page focused.

## Where to look

| Topic | Doc |
|-------|-----|
| **Paths & XDG roots** — DATA / CONFIG / STATE / CACHE / WORKSPACE | [`configuration/paths.md`](./configuration/paths.md) |
| **Environment variables** — `Settings` fields, provider keys, optional extras | [`configuration/env.md`](./configuration/env.md) |
| **LLM providers** — every prefix registered in `build_provider`, OAuth flows, capability YAML | [`configuration/providers.md`](./configuration/providers.md) |
| **Agent files** — `.md` frontmatter schema, validation, editing workflow | [`configuration/agents.md`](./configuration/agents.md) |
| **Built-in tools** — filesystem, shell, web, multimodal, memory | [`configuration/tools.md`](./configuration/tools.md) |
| **LSP diagnostics** — coding-mode language-server feedback on edits, server selection, `lsp:` config | [`configuration/lsp.md`](./configuration/lsp.md) |
| **Skills** — `SKILL.md` format, registration, builtin skill catalog | [`configuration/skills.md`](./configuration/skills.md) |
| **Sandbox & permissions** — deny-list paths, user `sandbox.yaml`, permission services | [`configuration/sandbox.md`](./configuration/sandbox.md) |

## Quick start

```bash
openagentd init        # interactive wizard — picks provider, seeds config
openagentd             # start the API server in the background
openagentd doctor      # health checks
```

`init` writes config to `~/.config/openagentd/` (XDG standard). The database lives at `~/.local/share/openagentd/openagentd.db`. Logs live at `~/.local/state/openagentd/logs/app/app.log`, with a separate error-only stream at `~/.local/state/openagentd/logs/app/app-error.log`.

Two `.env` files are loaded if present: `~/.config/openagentd/.env` takes priority over `.env` in the project root.

## Hooks

Built-in lifecycle hooks intercept the agent loop without modifying the core. The full API and per-hook reference is in [`agent/hooks.md`](./agent/hooks.md). Defaults active in `TeamMemberBase._handle_messages()`:

| Hook | Purpose |
|------|---------|
| `StreamPublisherHook` | Publishes SSE events for the response stream |
| `SummarizationHook` | Rolling-window summarization when context grows large |
| `inject_current_date` | Injects current date into the system prompt |
| `AgentTeamProtocolHook` | Team-only — injects communication protocol, workflow, and roster |
| `TeamInboxHook` | Team-only — drains the mailbox into `state.messages` before each model call |
| `WorkspaceInstructionsHook` | Coding mode — appends repo-level `AGENTS.md` |
| `SessionLogHook` | Writes verbose JSONL per session to `{STATE_DIR}/logs/sessions/` |
| `OpenTelemetryHook` | OTEL spans + metrics — see [`observability.md`](./observability.md) |
| `ToolResultOffloadHook` | Offloads very large tool results to disk and replaces them with a compact preview |
| `TitleGenerationHook` | Lead-only — generates a session title on the first user turn |

DB persistence is handled by **`SQLiteCheckpointer`** (passed to `agent.run()`), not by a hook. See [`agent/hooks.md#checkpointer`](./agent/hooks.md#checkpointer) and the loop's four sync points in [`agent/loop.md`](./agent/loop.md).

## Running

```bash
openagentd                   # start the API server in the background
openagentd start --lan --key # expose the server to mobile/LAN clients and save a LAN access key
openagentd stop              # stop background processes
openagentd restart           # restart the background server
openagentd status            # check if running
openagentd address           # show local and LAN server URLs
openagentd health            # run server/mobile diagnostics
openagentd logs              # tail the server log
openagentd doctor            # check system health
openagentd upgrade           # stop, upgrade, and restart if running
```

Migrations run automatically on startup. Desktop bundle users update via **OpenAgentd → Check for Updates…** in the menu bar; CLI/server users run `openagentd upgrade`.

For frontend + backend development with hot-reload, use `make dev` from a source checkout — uvicorn (`:8000` with `--reload`) + Vite (`:5173`) together.

- API: `http://localhost:4082/api`
- Interactive docs: `http://localhost:4082/docs`
- Desktop/mobile clients: use `openagentd address` to find the local or LAN URL. In shared networks, run `openagentd start --lan --key` once; `server.host`, `server.port`, and `server.access_key` are saved in `settings.yaml` for future restarts.
