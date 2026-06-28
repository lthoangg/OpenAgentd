---
title: Agent Engine Architecture
description: Module layout and entry points for LLM execution, context management, and multi-agent coordination.
status: stable
updated: 2026-05-16
---

# Agent Engine

Everything under `app/agent/` that drives LLM execution, context management, tool use, and multi-agent coordination.

## Module layout

```
app/agent/
├── agent_loop/         # Reasoning loop package
│   ├── core.py             # Agent class
│   ├── streaming.py        # Streaming + chunk assembly
│   ├── retry.py            # Retry + fallback provider chain
│   ├── tool_dispatch.py    # Parallel tool dispatch with interrupt
│   └── tool_executor.py    # Per-tool execution + sanitize_error
├── state.py            # RunContext, ModelRequest, AgentState (usage, capabilities, tool_names, metadata), UsageInfo, build_tool_chain
├── multimodal.py       # build_parts_from_metas() — attachment hint hydration for uploads
├── checkpointer.py     # Abstract Checkpointer + InMemoryCheckpointer + SQLiteCheckpointer
├── errors.py           # Domain exceptions
├── sandbox.py          # SandboxConfig, get_sandbox, set_sandbox (context var)
├── sandbox_config.py   # sandbox.yaml load/save — user-defined deny-glob patterns
├── tool_id_resolver.py # FIFO tool_call_id resolution for streaming
├── loader.py           # Loads agents/*.md — agent factory + AgentConfig schema
├── drift.py            # ConfigStamp + stamp_agent_files / detect_drift
├── permission.py       # Rule/Ruleset matching + AutoAllow / blocking permission services
├── hooks/              # Built-in lifecycle hooks (see hooks.md)
├── plugins/            # User-authored plugin loader + role contextvar (see plugins.md)
├── providers/          # LLM provider adapters
│   ├── factory.py          # build_provider("provider:model") — one match statement over the prefix
│   └── capabilities.py     # Dataclasses, defaults, prefix-only fallbacks
├── schemas/            # Pydantic wire types
│   ├── chat.py             # SystemMessage / HumanMessage / AssistantMessage / ToolMessage / ChatMessage
│   ├── agent.py            # RunConfig, AgentContext
│   └── events.py           # SSE event payloads
├── tools/              # Tool registry (@tool decorator) + built-ins
│   └── builtin/            # filesystem/, shell, web, date, skill, todo, schedule
└── mode/
    └── team/           # AgentTeam, TeamLead, TeamMember, mailbox
        ├── hooks/          # AgentTeamProtocolHook, TeamInboxHook
        ├── tools.py        # team_message
        └── manage.py       # team_manage (lead-only)
```

## Documents

| Document | What it covers |
|----------|---------------|
| [loop.md](./loop.md) | Reasoning loop, iteration lifecycle, retry, tool dispatch, interrupt |
| [hooks.md](./hooks.md) | Hook protocol, lifecycle order, all built-in hooks, checkpointer, custom hook patterns |
| [plugins.md](./plugins.md) | User-authored plugins — drop-in `.py` files loaded from `OPENAGENTD_PLUGINS_DIRS` |
| [tools.md](./tools.md) | Tool registry, `@tool` decorator, built-ins, injection paths |
| [teams.md](./teams.md) | Multi-agent coordination — team, mailbox, task board, protocol, drift detection |
| [team-lazy-spawn.md](./team-lazy-spawn.md) | Lazy member spawning + per-session instance IDs |
| [context.md](./context.md) | AgentState, RunContext, system prompt injection, metadata |
| [summarization.md](./summarization.md) | Rolling-window context compression — module-level config, mode-aware prompt + keep window |

## Entry points

| Use case | Entry point |
|----------|------------|
| Chat / coding session | `app/api/routes/team/chat.py` → `AgentTeam.handle_user_message(content, session_id)` |
| Standalone / test | Construct `Agent` directly — see [context.md](./context.md) |
