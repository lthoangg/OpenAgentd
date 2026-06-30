---
title: OpenAgentd Documentation
description: On-machine AI assistant with FastAPI backend, React web UI, multi-agent teams, and streaming SSE support.
status: stable
updated: 2026-06-01
---

# OpenAgentd

On-machine AI assistant. FastAPI backend, React web UI, runs locally.

Connects to LLM providers (Anthropic, Gemini, Vertex AI, OpenAI, OpenRouter, Copilot OAuth, Codex OAuth, xAI, DeepSeek, Bedrock, NVIDIA NIM, local proxies, Ollama), maintains persistent sessions, supports multimodal input, streams over SSE, and coordinates multi-agent teams.

**Quick start.** [`install.md`](./install.md) → `openagentd init` → `openagentd`. Use `openagentd start --lan --key` plus `openagentd address` for desktop/mobile clients on your network.

---

## Documentation

### Getting started

| Doc | What it covers |
|-----|----------------|
| [Features](./features.md) | **Canonical catalogue of every user-visible feature**, version-cited. Source of truth for slides, README, comparison docs. |
| [Roadmap / issues](./roadmap.md) | Short planning note with links to GitHub issues for feature requests, future work, and known issues. |
| [Install](./install.md) | Desktop app (macOS/Linux) first; CLI/uv/pipx/pip, source. First-run wizard. |
| [Migration](../../MIGRATION.md) | Move setup from OpenClaw, Hermes, Claude Code, Codex CLI, or older OpenAgentd installs. |
| [CLI reference](./cli.md) | Server lifecycle and diagnostics: `start --lan --key`, `restart`, `address`, `health`, `doctor`, `upgrade`, and more. |
| [Configuration](./configuration.md) | Env vars, XDG paths, agent `.md` files, providers, tools, skills, sandbox, hooks. |
| [Slash commands](./commands.md) | Reusable `/name` prompt templates; reuses your opencode command library. |
| [Shell commands](./shell-commands.md) | Opencode-style `!command` sends that run directly through the shell tool. |
| [Troubleshooting](./troubleshooting.md) | Common install & runtime issues — desktop app then CLI / server. |
| [Comparison](./comparison.md) | How OpenAgentd compares to Claude Code, Codex CLI, Cursor/Windsurf, Aider, opencode. |

### Architecture & internals

| Doc | What it covers |
|-----|----------------|
| [Architecture](./architecture.md) | C4 diagrams, in-memory SSE streaming, SSE protocol, request flow. |
| [Agent engine](./agent/index.md) | Reasoning loop, hooks, tools, teams, plugins, context, summarization. |
| [API reference](./api/index.md) | HTTP routes, SSE event payloads, file/upload handling. |

### Operations

| Doc | What it covers |
|-----|----------------|
| [Logging](./logging.md) | App log + per-session JSONL, rotation, console format. |
| [Observability](./observability.md) | OpenTelemetry spans, DuckDB-backed `/api/observability/*`, `/telemetry` UI. |
| [Desktop distribution](./desktop.md) | Tauri v2 shell, Python sidecar, token auth, release pipeline. |
| [Mobile app](./mobile.md) | Tauri mobile shell for remote OpenAgentd API servers. |
| [Title generation](./title-generation.md) | LLM-generated session titles, SSE event, config. |

### Frontend (`web/`)

| Doc | What it covers |
|-----|----------------|
| [App chrome](./web/chrome.md) | Shared header, platform detection, Tauri drag, macOS overlay. |
| [Chat input & queue](./web/chat-input.md) | Consecutive message queuing, `PendingMessageQueue`. |
| [Coding sessions UI](./web/coding-sessions.md) | Coding session restore, workspace sidebar pagination, reload/error handling. |
| [Voice input](./web/voice-input.md) | Client speech recognition and transcript insertion. |
| [Tool results](./web/tool-results.md) | Per-tool result renderers. |
| [Workspace Files panel](./web/workspace-files.md) | Files drawer, previews, live invalidation. |
| [Todos popover](./web/todos.md) | Task list display, live invalidation, shortcut. |
| [Mobile layout](./web/mobile.md) | Phone-first responsive design — breakpoints, safe areas. |

### Contributing

| Doc | What it covers |
|-----|----------------|
| [Guidelines](./guidelines.md) | Dev commands, code style, testing, GitHub conventions. |
| [Team testing](./testing/team.md) | Manual test guide for the multi-agent team flow. |

---

## Codebase layout

```
app/          FastAPI backend
  agent/      LLM engine (loop, hooks, tools, providers, teams, plugins)
  api/        HTTP routes (thin — logic in services/)
  core/       Config, DB, logging, paths, middleware
  models/     SQLModel ORM tables
  services/   chat_service, coding_workspace_service, lsp/, memory_stream_store, title_service, team_manager
  cli/        openagentd CLI entry points
web/          React frontend (Vite + Bun)
desktop/      Tauri v2 desktop shell
seed/         Default agents and empty mcp.json (copied on first init)
tests/        pytest test suite (mirrors app/)
documents/    Developer docs (this directory)
```

---

## Key design rules

Invariants live next to the code they govern. Start at the linked file when you need to verify a rule before changing related code.

| Subsystem | Where the rules live |
|-----------|---------------------|
| Stream store & SSE | [`architecture.md`](./architecture.md), `app/services/memory_stream_store.py` |
| Agent loop & hooks | [`agent/loop.md`](./agent/loop.md), [`agent/hooks.md`](./agent/hooks.md) |
| Tools & permissions | [`agent/tools.md`](./agent/tools.md), `app/agent/tools/__init__.py` |
| Teams | [`agent/teams.md`](./agent/teams.md), `app/agent/mode/team/` |
| Context & summarization | [`agent/context.md`](./agent/context.md), [`agent/summarization.md`](./agent/summarization.md) |
| LSP diagnostics (coding mode) | [`configuration/lsp.md`](./configuration/lsp.md), `app/services/lsp/`, `app/agent/hooks/lsp.py` |
| Plugins | [`agent/plugins.md`](./agent/plugins.md), `app/agent/plugins/` |
| Filesystem & paths | `app/core/paths.py`, `app/agent/sandbox.py` |
| Frontend conventions | [`web/`](./web/) |
