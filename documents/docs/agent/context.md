---
title: Context Engineering & Message Flow
description: Message types, system prompt injection, RunContext, AgentState, and context window tracking.
status: stable
updated: 2026-04-21
---

# Context Engineering

Context engineering is how openagentd controls what the LLM sees on each call: which messages survive, how the system prompt is shaped, and how per-run data flows through the agent.

**Sources:** `app/agent/state.py`, `app/agent/schemas/agent.py`, `app/agent/agent_loop/`, `app/services/chat_service.py`

---

## Message types

All messages are discriminated by `role`. See `app/agent/schemas/chat.py` for the message type definitions (`SystemMessage`, `HumanMessage`, `AssistantMessage`, `ToolMessage`, `ChatMessage`).

---

## What the LLM sees

The loop sends `state.messages_for_llm` to the LLM on each call — not raw `state.messages`. This property filters out system messages and any messages with `exclude_from_context=True` (see `app/agent/state.py:AgentState.messages_for_llm`).

`SystemMessage` rows are stripped here — the system prompt is injected separately per call via `_stream_and_assemble`. Messages with `exclude_from_context=True` are also excluded. Summary rows (`is_summary=True`) are excluded from the UI but included in the LLM context as a single compressed message.

Messages are marked `exclude_from_context=True` when `SummarizationHook` runs — see [`summarization.md`](summarization.md).

---

## System prompt injection

The system prompt is **not** stored in `state.messages`. Instead, `_stream_and_assemble` prepends it as `SystemMessage` at index 0 immediately before each provider call, using the prompt from the current `ModelRequest` (see `app/agent/agent_loop/core.py:_stream_and_assemble`).

`req.system_prompt` starts as a copy of `state.system_prompt`, which itself starts as `Agent.system_prompt`. Hooks can override it per call via `wrap_model_call` using `request.override(system_prompt=new_prompt)`, which returns a new immutable `ModelRequest` — shared state is never mutated.

---

## Consecutive user message merge

When a user presses Stop and sends an additional message before the agent has replied (the "I forgot to add ..." pattern), `state.messages` ends up with adjacent `HumanMessage` rows. The DB keeps them separate — that ordering is intentional. At the wire, `_stream_and_assemble` calls `_merge_consecutive_user_messages` to join adjacent plain-text user rows with `\n\n` before handing them to the provider; otherwise some providers (e.g. OpenAI gpt-5.5) treat the latest user message as superseding earlier ones and drop the prior instructions. Multimodal pairs (either side has `.parts`) are kept separate. See `app/agent/agent_loop/streaming.py`.

---

`RunContext` is a **frozen** dataclass created once at the start of `agent.run()` (see `app/agent/state.py:55`). It carries immutable identity for the run (`session_id`, `run_id`, `agent_name`, `session_created_at`) and is passed to every hook alongside `AgentState`.

Because it is frozen, hooks and tools can safely share it across concurrent tool calls without locks. `session_created_at` is decoded from the UUIDv7 `session_id` by `RunConfig`'s model validator — no extra DB query. Hooks read it via `ctx.session_created_at` to inject a date that is stable for the lifetime of the session (see `inject_current_date`).

---

`AgentState` is a **mutable** dataclass created fresh per `agent.run()` call (see `app/agent/state.py:110`) and passed to every hook. It is the shared execution context for the entire turn, carrying messages, token usage, metadata, system prompt, context, capabilities, and tool names.

### UsageInfo

`UsageInfo` (see `app/agent/state.py:99`) tracks token counters per LLM call and cumulatively: `last_prompt_tokens`, `last_completion_tokens`, `total_tokens`, and `last_usage` (raw dict from provider).

The loop populates `state.usage` after each LLM response. `SummarizationHook` reads `state.usage.last_prompt_tokens` to decide whether to compress.

### Typed fields (not metadata)

| Field | Type | Written by | Read by |
|-------|------|-----------|--------|
| `capabilities` | `ModelCapabilities` (composite `.input`, `.output`) | `agent.run()` start | providers, etc. |
| `tool_names` | `list[str]` | `agent.run()` start | `SessionLogHook` |

These are proper typed fields on `AgentState` — not entries in `metadata`. Use `state.capabilities` and `state.tool_names` directly.

### Remaining metadata entries

| Key | Type | Written by | Read by |
|-----|------|-----------|--------|
| `session_id` | `str` | `agent.run()` start | built-in tools needing session scope |
| `agent_name` | `str` | `agent.run()` start | `todo_manage` claim action |
| `team_mode` | `str` (`"normal"` \| `"coding"`) | `TeamMemberBase._handle_messages` via `RunConfig.metadata` | tool executor — re-exposed as injected `_mode` arg to `schedule_task` |
| `team_workspace` | `str \| None` | same | tool executor — re-exposed as injected `_workspace` arg to `schedule_task` |
| `_todos` | `dict` | `todo_manage` | `todo_manage` subsequent calls in the same turn |
| `_multimodal_tool_parts` | `dict[str, list[ContentBlock]]` | tool executor (when tool returns `ToolResult`) | agent loop (attaches to `ToolMessage.parts`) |

`RunConfig.metadata` is the caller-supplied bridge: the agent loop copies entries into `state.metadata` (via `setdefault`, so explicit `agent_name` / `session_id` win). The tool executor re-projects `team_mode` / `team_workspace` as proper `InjectedArg` parameters so tools declare the dependency in their signature — see `app/agent/tools/builtin/schedule.py` and [`tools.md`](tools.md#scheduler-builtinschedulepy).

> **Note:** `total_tokens`, `last_usage` are no longer stored in `metadata` — use `state.usage` instead. `tool_names` and `capabilities` were also promoted from metadata to typed fields.

---

## AgentContext — typed per-invocation data

`AgentContext` is a Pydantic `BaseModel` base for user/env data that shapes agent behaviour. Pass a typed subclass to `Agent()`:

```python
from app.agent.schemas.agent import AgentContext
from app.agent.agent_loop import Agent

class UserContext(AgentContext):
    user_id: int
    user_group: str = "default"
    locale: str = "en"
    feature_flags: dict[str, bool] = {}

agent = Agent(
    llm_provider=provider,
    context=UserContext(user_id=42, user_group="premium"),
    hooks=[DynamicSystemPromptHook()],
)
```

Hooks read context via `state.context`:

```python
class DynamicSystemPromptHook(BaseAgentHook):
    async def before_agent(self, ctx: RunContext, state: AgentState) -> None:
        if state.context and state.context.user_group == "premium":
            state.system_prompt = "You are a premium assistant."
```

**Rules:**
- Always subclass `AgentContext` — never pass a plain dict.
- Treat context as **read-only at runtime** — do not mutate it in hooks.
- `AgentState` is for execution telemetry; `AgentContext` is for per-request user data.

---

## RunConfig

```python
from app.agent.schemas.agent import RunConfig

config = RunConfig(session_id=str(session_id))
result = await agent.run(messages, config=config, checkpointer=SQLiteCheckpointer(session_factory))
```

`run_id` is auto-generated (UUIDv7) if not provided. `session_created_at` is decoded automatically from `session_id` by a model validator — callers never set it manually. Non-UUID `session_id` values (e.g. synthetic test IDs) are silently skipped; `session_created_at` stays `None`.

If `config` is `None`, `session_id` is `None` in `RunContext` — `SQLiteCheckpointer` skips persistence silently.

---

## Per-run tool scoping

Tools passed to `agent.run(injected_tools=[...])` are merged with constructor tools for that run only. `self._tools` is never mutated — concurrent runs are safe (see `app/agent/agent_loop/core.py` for the tool merging implementation).

---

## Sandbox context

The active sandbox (workspace root for filesystem tools) is stored in a `contextvars.ContextVar` via `set_sandbox(SandboxConfig(...))`. Single-agent mode sets it once at startup; team members set it per run activation and reset after completion (see `app/agent/sandbox.py`).

`get_sandbox()` is called inside every filesystem tool (via `validate_path`) and inside `shell` (via `check_command` — best-effort path-token scan) to enforce the denylist. The sandbox uses a denylist model: absolute paths anywhere on disk are accepted unless they resolve under a denied root (`OPENAGENTD_DATA_DIR`, `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) or match a user-defined glob pattern from `sandbox.yaml`. Symlinks are rejected only when their target lands inside a denied root; tilde paths are always rejected. See [`tools.md`](tools.md#filesystem-builtinfilesystem) for the full rules.

---

## Context window size tracking

Token usage is written to `state.usage` after each LLM call: `last_prompt_tokens`, `last_completion_tokens`, `total_tokens`, and `last_usage` (raw dict with cache/thought tokens).

The loop also attaches `extra={"usage": ...}` to each `AssistantMessage` before appending it to `state.messages`. `checkpointer.sync()` persists this to `SessionMessage.extra.usage` in the DB. On the next HTTP request, the initial `state.usage.last_prompt_tokens` is seeded from the most recent persisted assistant message's `extra.usage` — making token tracking stateless across HTTP requests without a DB query inside the hook.

---

## Context window after summarization

Before summarization (`state.messages_for_llm`):
```
[system]
[user turn 1] [assistant 1] [tool...] ...
[user turn N] [assistant N]
```

After summarization (`state.messages_for_llm` — `exclude_from_context` messages filtered out):
```
[system]
[user — "[Summary of earlier conversation]\n..."]   ← is_summary=True
[last keep_last_assistants turns verbatim]
```

Messages with `exclude_from_context=True` remain in `state.messages` and in the DB for audit. `GET /api/chat/sessions/{id}` returns them (minus the summary row) so the UI shows the full unabridged conversation.

---

## BaseMessage new fields

`BaseMessage` (base for all chat message types) carries three new fields:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `exclude_from_context` | `bool` | `False` | Filtered out by `state.messages_for_llm`; set by `SummarizationHook` on old messages |
| `is_summary` | `bool` | `False` | Marks a message as a generated summary; excluded from UI responses |
| `extra` | `dict \| None` | `None` | Open bag for provider metadata; loop writes `{"usage": {...}}` on `AssistantMessage` |
