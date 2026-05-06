---
title: OpenAgentd Documentation
description: On-machine AI assistant with FastAPI backend, React web UI, multi-agent teams, and streaming SSE support.
status: stable
updated: 2026-04-29
---

# OpenAgentd

On-machine AI assistant with a FastAPI backend and React web UI.

It runs locally, connects to LLM providers (Gemini, Vertex AI, OpenAI-compatible APIs, GitHub Copilot, OpenAI Codex, xAI Grok, AWS Bedrock), maintains persistent conversation sessions, supports multimodal input (text, images, documents), streams responses over SSE, and can coordinate multi-agent teams.

Quick start: `Makefile` (`make run` for the backend on :8000; `cd web && bun dev` for the UI on :5173). Provider keys and agent `.md` files are documented in [`configuration.md`](./configuration.md).

---

## Documentation

| Section                                              | What it covers                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Architecture](./architecture.md)                    | C4 diagrams, in-memory SSE streaming, SSE protocol, agent loop                                       |
| [Configuration](./configuration.md)                  | Env vars, agent `.md` files, sandbox, skills, settings UI                                            |
| [Guidelines](./guidelines.md)                        | Dev commands, code style, testing, conventions                                                       |
| [Logging](./logging.md)                              | Two-tier logging: app log, per-session logs, JSONL events, log levels                                |
| [Observability](./observability.md)                  | OpenTelemetry spans, metrics, JSONL partitions, export-tier sampling, DuckDB HTTP API, `/telemetry` UI |
| [Agent engine](./agent/index.md)                     | Reasoning loop, hooks, tools, teams, context management                                              |
| [API reference](./api/index.md)                      | HTTP endpoints, SSE events, file handling                                                            |
| [Workspace Files panel](./web/workspace-files.md)    | Web UI Files drawer — listing endpoint, previews, live invalidation                                  |
| [Todos popover](./web/todos.md)                      | Web UI Todos popover — task list display, live invalidation, keyboard shortcut                       |
| [Mobile layout](./web/mobile.md)                     | Phone-first responsive design — breakpoints, safe areas, master/detail patterns, per-component behaviour |
| [Chat input & queue](./web/chat-input.md)            | Consecutive message queuing, drain-on-done behaviour, `PendingMessageQueue` UI                       |
| [Voice input](./web/voice-input.md)                  | Browser microphone recording, local speech-to-text, transcript insertion, and settings UI            |
| [Title generation](./title-generation.md)            | LLM-generated session titles, SSE event, sidebar animation                                           |
| [Team testing](./testing/team.md)                    | Manual test guide — multi-agent team                                                                 |

---

## Codebase layout

```
app/          FastAPI backend
  agent/      LLM engine (loop, hooks, tools, providers, teams)
  api/        HTTP routes + schemas
  core/       Config, DB, logging, middleware
  models/    SQLModel ORM tables
  services/   chat_service, wiki, dream, stream_store
web/          React frontend (Vite + Bun)
manual/       Manual HTTP test scripts
tests/        pytest test suite
documents/    Developer docs (this directory)
  docs/       Architecture, configuration, agent engine, API
  styling-specs/ Design tokens and brand reference
  techdebts/  Tracked tech debt
```

---

## Key design rules

The invariants that hold the system together live next to the code they govern, not duplicated here. Start at the linked file when you need to verify a rule before changing related code.

| Subsystem            | Where the rules live                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| Stream store & SSE   | [`architecture.md`](./architecture.md), `app/services/stream_store.py`              |
| Agent loop & hooks   | [`agent/loop.md`](./agent/loop.md), [`agent/hooks.md`](./agent/hooks.md)            |
| Tools & permissions  | [`agent/tools.md`](./agent/tools.md), `app/agent/tools/__init__.py`                 |
| Teams                | [`agent/teams.md`](./agent/teams.md), `app/agent/mode/team/`                        |
| Memory & summarization | [`agent/memory.md`](./agent/memory.md), [`agent/summarization.md`](./agent/summarization.md) |
| Filesystem & paths     | `app/core/paths.py`, `app/agent/sandbox.py`                                                   |
| Frontend conventions | [`web/`](./web/)                                                                    |
