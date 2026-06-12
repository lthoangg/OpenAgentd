---
title: Agent Hooks & Lifecycle
description: Hook protocol, lifecycle order, built-in hooks, and custom hook patterns.
status: stable
updated: 2026-05-16
---

# Agent Hooks

**Source:** `app/agent/hooks/`

Hooks intercept the agent loop at lifecycle points without modifying `Agent`. All invocations are wrapped in `_safe_invoke_hooks()` — a buggy hook never crashes the agent run; exceptions are logged and swallowed.

---

## Base class

All hook methods have default no-op implementations. Subclass `BaseAgentHook` and override only what you need:

```python
class BaseAgentHook(ABC):
    async def on_start(self) -> None: ...
    async def on_end(self) -> None: ...
    async def before_agent(self, ctx: RunContext, state: AgentState) -> None: ...
    async def after_agent(self, ctx: RunContext, state: AgentState, response: AssistantMessage) -> None: ...
    async def before_model(self, ctx: RunContext, state: AgentState, request: ModelRequest) -> ModelRequest | None: ...
    async def wrap_model_call(self, ctx: RunContext, state: AgentState, request: ModelRequest, handler: ModelCallHandler) -> AssistantMessage: ...
    async def on_model_delta(self, ctx: RunContext, state: AgentState, chunk: ChatCompletionChunk) -> None: ...
    async def after_model(self, ctx: RunContext, state: AgentState, response: AssistantMessage) -> None: ...
    async def on_rate_limit(self, ctx: RunContext, state: AgentState, retry_after, attempt, max_attempts) -> None: ...
    async def wrap_tool_call(self, ctx: RunContext, state: AgentState, tool_call: ToolCall, handler: ToolCallHandler) -> str: ...
```

`ToolCallHandler = Callable[[RunContext, AgentState, ToolCall], Awaitable[str]]`
`ModelCallHandler = Callable[[ModelRequest], Awaitable[AssistantMessage]]`

All methods receive both `RunContext` (frozen, immutable identity) and `AgentState` (mutable execution state). See [`context.md`](context.md) for details on both types.

See `app/agent/hooks/__init__.py:BaseAgentHook` for the full base class definition.

---

## Lifecycle order

```
before_agent        ← once, before first model call
│
└─ per iteration:
    before_model(ctx, state, request) → ModelRequest | None   ← modify request or pass-through
    wrap_model_call(ctx, state, request, handler)              ← intercept; must call handler(request)
        └─ _stream_and_assemble → on_model_delta per chunk    ← innermost handler
    after_model     ← after full response assembled
    │
    └─ per tool call (parallel):
        wrap_tool_call ← hook chain: pre + execute + post
│
after_agent         ← once, after final response
```

`on_rate_limit` fires inside `_stream_with_retry` on 429 before each retry sleep. If a `fallback_provider` is configured and the primary model exhausts all retries, the agent switches to the fallback provider (which gets its own retry budget). `on_rate_limit` fires for both primary and fallback providers.

---

## Tool hook chain

`wrap_tool_call` follows the **chain-of-responsibility pattern**:

```python
async def wrap_tool_call(self, ctx: RunContext, state: AgentState, tool_call: ToolCall, handler: ToolCallHandler) -> str:
    # --- pre-execution ---
    result = await handler(ctx, state, tool_call)   # MUST call handler
    # --- post-execution ---
    return result                                    # MUST return result
```

Hooks are chained in declaration order: `Hook0 → Hook1 → … → execute_fn`. The last link in the chain is the actual tool executor in `app/agent/agent_loop/tool_executor.py`. `build_tool_chain()` in `state.py` assembles the chain once per run.

---

## Built-in hooks

### `StreamingHook`

**File:** `streaming.py`

Bridges the agent loop to a consumer via an `asyncio.Queue`. **Not used by the built-in chat or team routes** — both use `StreamPublisherHook` directly. Available for custom integrations that need an in-process event queue.

- `on_model_delta` → puts `ChatCompletionChunk` on queue.
- `wrap_tool_call` → puts `ToolStartSignal` (before), calls `handler(ctx, state, tool_call)`, puts `ToolEndSignal` (after).
- `on_rate_limit` → puts `RateLimitSignal`.
- `after_agent` → puts `_SENTINEL` → consumer raises `StopAsyncIteration`.

```python
hook = StreamingHook()
asyncio.create_task(agent.run(messages, hooks=[hook]))

async for item in hook:
    if isinstance(item, ChatCompletionChunk):
        ...
    elif isinstance(item, ToolStartSignal):
        ...
```

Queue items: `ChatCompletionChunk | ToolStartSignal | ToolEndSignal | RateLimitSignal`.

---

### `StreamPublisherHook`

**File:** `stream_publisher.py`

Used by **team members** — the unified SSE event publishing hook for the in-memory stream store. Calls `stream_store.push_event()` directly; no intermediate queue.

- `on_model_delta` → pushes `thinking` / `message` / `tool_call` / per-call `usage` events; token values are provider-reported absolute counts for that model call.
- `wrap_tool_call` → pushes `tool_start` (before), streams optional `tool_output_delta` chunks during execution, pushes `tool_end` (after).
- `on_rate_limit` → pushes `rate_limit` event.
- `after_agent` → pushes an authoritative aggregate `usage` event with `metadata.turn_total=True` when a turn made `>1` model calls, then resets counters. Frontend consumers use this aggregate to replace the current turn's live input/output/cache counts and avoid showing only the final call.

`agent_done` is **not** emitted here — `after_agent` fires every time `agent.run()` exits, including on `<sleep>` mid-turn re-activations. The `agent_status: idle` event (emitted from `_run_activation`'s finally block) is the correct per-agent completion signal; `done` (team-wide) is emitted by `_try_emit_done()`.

`mark_done` is **not** called here — `AgentTeam._try_emit_done()` calls it once after all live members become idle.

**FIFO tool_call_id:** Uses `ToolIdResolver` — handles providers that send wrong `index` values for parallel tool calls.

```python
hook = StreamPublisherHook(session_id=session_id_str, agent_name=agent.name)
```

---

### `SummarizationHook` / `build_summarization_hook`

**File:** `summarization.py`

Rolling-window context compression. **Pure state transform** — reads `state.usage.last_prompt_tokens` to decide whether to compress, then mutates `state.messages` directly. No DB access. See [`summarization.md`](summarization.md) for full details.

`build_summarization_hook` is the preferred factory for call sites. It has no per-agent or file-based configuration — numeric tuning lives as ``DEFAULT_*`` constants in ``summarization.py``. The only runtime input is ``mode``, which selects both the bundled prompt and the ``keep_last_assistants`` window:

```python
from app.agent.hooks.summarization import build_summarization_hook

hook = build_summarization_hook(default_provider=provider, mode=team.mode)
if hook:
    hooks.append(hook)
```

Returns ``None`` only when ``DEFAULT_PROMPT_TOKEN_THRESHOLD <= 0`` (operator-level kill switch). For custom integrations, construct ``SummarizationHook`` directly:

```python
hook = SummarizationHook(
    llm_provider=provider,
    prompt_token_threshold=DEFAULT_PROMPT_TOKEN_THRESHOLD,
    keep_last_assistants=3,   # 0 = summarise everything below threshold
    summary_prompt="...",     # required
)
```

---

### `ToolResultOffloadHook`

**File:** `tool_result_offload.py`

Protects the context window from large tool outputs. Fires in `wrap_tool_call` — intercepts the result string immediately after tool execution. If the result exceeds `char_threshold` chars, the full content is saved to `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/.tool_results/{agent_name}/{tool_call_id}.txt`, and the tool message content is replaced with a compact summary.

The replacement message includes the file path so the agent can call `read` to retrieve the full output if needed. Metadata (`offloaded`, `path`, `lines`, `chars`) is stashed in `state.metadata["_offloaded_tool_results"][tool_call_id]`.

```python
hook = ToolResultOffloadHook(
    char_threshold=40000,   # results longer than this are offloaded (~10k tokens)
    preview_chars=1000,     # chars kept from head & tail as preview
)
```

Defaults are module-level constants in `app/agent/hooks/tool_result_offload.py` (`DEFAULT_CHAR_THRESHOLD`, `DEFAULT_PREVIEW_CHARS`); override per-instance via the constructor args shown above.

Replacement message format (head + tail preview):
```
[Tool result offloaded — content saved to session artifacts]
File: {OPENAGENTD_DATA_DIR}/sessions/{session_id}/.tool_results/assistant/{tool_call_id}.txt
Size: 1,234 lines · 56,789 chars

Preview (first):
{first 1000 chars}
… (54,789 chars omitted)

Preview (last):
{last 1000 chars}
```

**Write failure** — if the file write fails (e.g. disk full), the original result string is returned unchanged and a warning is logged. Tool execution is never broken by offload failure.

---

## Checkpointer

Persistence is handled by the **Checkpointer**, not by hooks. Hooks do not persist messages.

```python
class Checkpointer(ABC):
    async def load(self, session_id: str) -> AgentState | None: ...
    async def sync(self, ctx: RunContext, state: AgentState) -> None: ...
    async def seed_state(self, session_id: str, state: AgentState) -> None: ...
    async def mark_loaded(self, session_id: str) -> None: ...
```

It's an `ABC` (not a `Protocol`) — concrete classes subclass it directly. `seed_state` and `mark_loaded` are used by `SQLiteCheckpointer` to seed `state.usage.last_prompt_tokens` from the most recent persisted assistant message, so summarization decisions are correct on resume without an extra DB query inside the hook.

### Implementations

| Class | Use case |
|-------|----------|
| `InMemoryCheckpointer` | Tests — stores state in a dict, no I/O |
| `SQLiteCheckpointer` | Production — calls `save_message()` from `chat_service` |

### Sync points

The agent loop calls `checkpointer.sync(ctx, state)` at **4 points** per iteration:

1. After `before_model` — persists any state mutations from hooks (e.g. summarization)
2. After `after_model` — persists the new `AssistantMessage` with token usage
3. After each tool execution — persists the `ToolMessage`
4. After `after_agent` — final state flush

Empty `AssistantMessage` objects (no `content`, no `reasoning_content`, no `tool_calls`, and not a summary) are skipped during sync — this avoids persisting no-op rows when the agent is interrupted before generating any output.

### Stream-store commit after sync

After a successful `sync()`, `SQLiteCheckpointer` calls `stream_store.commit_agent_content(stream_session_id, agent_name)` to drop the just-persisted content from the SSE replay blob. Without this, a mid-turn refresh between `sync()` and the team-wide `mark_done()` renders the same assistant text, thinking, and tool cards twice — once from the DB (via `loadSession → blocks[]`) and once from the replay (via `connectStream → currentBlocks[]`). These are **two separate frontend arrays**, so the `toolCallId` dedup in `web/src/utils/blocks.ts` cannot catch the collision.

Both kwargs are required for the commit to fire — either missing → silent no-op:

| Kwarg | Value in team mode |
|-------|--------------------|
| `stream_session_id` | The **lead's** session id (the shared SSE stream every team agent publishes to) |
| `agent_name` | The owning agent's name — scopes the commit to `content[agent]`, `thinking[agent]`, and `tool_calls[?agent==agent_name]` |

Team members wire both kwargs in `app/agent/mode/team/member.py::_run_activation` when constructing their per-member checkpointer. Single-agent chat does not yet opt in (there is only one agent publishing, so cross-agent corruption is not possible — but commit-after-persist would still eliminate the refresh duplicate there; out of scope for now).

### Usage

```python
# Stateless / single-agent
checkpointer = SQLiteCheckpointer(session_factory)

# Team member — enables replay-buffer commit
checkpointer = SQLiteCheckpointer(
    session_factory,
    stream_session_id=lead_session_id,   # lead's session = shared SSE stream
    agent_name=self.name,                # this member's agent name
)

result = await agent.run(messages, checkpointer=checkpointer)
```

Pass `checkpointer=None` (default) to skip all persistence — useful for unit tests or stateless runs.

---

### `@dynamic_prompt` / `inject_current_date`

**File:** `dynamic_prompt.py`

`@dynamic_prompt` is a decorator that turns a plain function into a `wrap_model_call` hook. The decorated function receives a `PromptRequest` — a lightweight view with `base_prompt`, `state`, and `ctx` — and returns the new prompt string. Fires on **every model call**, not just the first.

```python
from app.agent.hooks.dynamic_prompt import dynamic_prompt, PromptRequest

@dynamic_prompt
def my_prompt(request: PromptRequest) -> str:
    return request.base_prompt + "\n\nBe concise."
```

The prompt is applied via `request.override(system_prompt=...)` — immutable, no shared state mutation.

**`inject_current_date`** is the built-in instance. It appends the session creation date to the system prompt:

```
Current date (UTC): 2026-04-11
```

The date is read from `ctx.session_created_at` (decoded from the UUIDv7 session ID) so it is **frozen at session creation** — it does not drift to a new day if the user sends a follow-up message after midnight. Falls back to `datetime.now(UTC)` for stateless runs with no `session_id`.

```python
from app.agent.hooks.dynamic_prompt import inject_current_date

# registered automatically by team member _handle_messages()
```

---

### `SessionLogHook`

**File:** `session_log.py`

Writes verbose structured JSONL to `{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/{agent}.jsonl` — see [`logging.md`](../logging.md).

| JSONL event | When | Fields |
|-------------|------|--------|
| `agent_start` | `before_agent` | trigger message, context message count, role distribution, tools |
| `model_call` | `before_model` | iteration, context message count, role distribution |
| `assistant_message` | `after_model` | content, reasoning (truncated to 2 000 chars), `has_tool_calls`, `tool_call_count`, `tool_names`, `duration_ms` |
| `tool_call` | `wrap_tool_call` | tool name, arguments, `tool_call_id`, `duration_ms` |
| `tool_result` | `wrap_tool_call` | tool name, truncated result, `tool_call_id`, `duration_ms` |
| `usage` | `on_model_delta` (when chunk carries usage) | prompt/completion/total/cached/thoughts/tool-use tokens, model |
| `agent_done` | `after_agent` | content, elapsed seconds, iterations, total tokens |

`StreamPublisherHook` also persists assistant turn and tool durations into message `extra.duration_ms` so the UI can show them after reload. Assistant-message `duration_ms` represents the user-visible turn wall-clock time; per-model response timing remains available through `SessionLogHook` / OpenTelemetry model-call spans.

```python
hook = SessionLogHook(session_id=session_id, agent_name=agent_name)
```

---

### `TitleGenerationHook` / `build_title_generation_hook`

**File:** `title_generation.py`

Generates an LLM-based session title on the first user turn and pushes a
`title_update` SSE event. Only injected for `role: lead` agents. Construct
via `build_title_generation_hook` (reads title generation settings from
`settings.yaml` and uses the built-in prompt); returns `None` when disabled or
model-less.

`before_agent` fires when:
1. `ctx.session_id` is set, **and**
2. `state.messages` contains no `AssistantMessage` (first turn), **and**
3. There is a non-empty `HumanMessage` in state, **and**
4. The user message does **not** start with `[Scheduled Task:` — sessions fired
   by the scheduler are skipped entirely (no LLM call, no SSE event). The check
   is message-based because `ChatSession.scheduled_task_name` is stamped only
   *after* `dispatch_user_message` returns, so it is unavailable when the hook
   fires.

`after_agent` does a best-effort `asyncio.wait_for` (default 3 s) so the
`title_update` event arrives before `done`. Set `wait_timeout_seconds: 0` in
the config for fully non-blocking mode.

See [`title-generation.md`](../title-generation.md) for full configuration,
LLM call details, SSE payload, client handling, and observability.

---

### `WikiInjectionHook`

**File:** `wiki_injection.py`

Injects `USER.md` (and selected `topics/` material) into the system prompt on every model call so the agent has stable cross-session memory. See [`memory.md`](./memory.md) for the wiki layout and dream-driven note synthesis.

---

### `WorkspaceInstructionsHook`

**File:** `workspace_instructions.py`

Coding-mode only. Reads a root `AGENTS.md` in the active workspace (when present and under the size limit) and appends it to the system prompt, so the agent picks up per-repo conventions without the user copying them into the agent `.md`.

---

### `OpenTelemetryHook`

**File:** `otel.py`

Wraps each model call in an OTEL span and emits per-turn metrics. See [`observability.md`](../observability.md) for the span hierarchy, attribute schema, and DuckDB-backed `/api/observability/*` endpoints. Registered in `TeamMemberBase._handle_messages()` alongside the streaming/protocol hooks.

`TelemetryHook` (`telemetry.py`) is a legacy lightweight counterpart kept for tests that don't initialise OTEL.

---

### `build_memory_flush_hook`

**File:** `memory_flush.py`

Optional factory that returns a hook flushing dream-synthesis events to disk at the end of each turn. Off by default — see [`memory.md`](./memory.md) for when to enable it.

---

### `AgentTeamProtocolHook`

**File:** `app/agent/mode/team/hooks/team_prompt.py`

Injected for **all team agents** (lead and members). Appends team operating protocol to `state.system_prompt` via `wrap_model_call`:
- Communication rules (message format, output constraints)
- Role-specific workflow (lead vs member)

The injected protocol is **static per session** — it carries no dynamic roster, so the system prompt stays byte-stable across turns for prompt caching. Roster changes reach the model as append-only `[system]` history (`_persist_roster_change`) and `team_message`/`team_manage` tool results, never by mutating the prompt.

Agent system prompts (`.md` body) stay role-specific (expertise only) — all shared team protocol is injected here. Tool-mechanical rules (batching, prefix stripping) live in the `team_message` tool description, not in the protocol.

```python
hook = AgentTeamProtocolHook(team=team, agent_name="explorer")
```

Lead gets: delegation workflow, partial-result handling, and user-visible final/progress response rules.
Members get: task workflow, incremental delivery rules, `<sleep>` convention.

---

### `TeamInboxHook`

**File:** `app/agent/mode/team/hooks/team_inbox.py`

Injected for **all team agents** (lead and members). Drains the mailbox queue at the start of each agent loop iteration via `before_model`:

1. Non-blocking `receive_nowait()` drain — collects all messages that arrived while tools were executing in the previous iteration.
2. Persists each message via `_persist_inbox()` (same path as activation inbox messages).
3. Emits an `inbox` SSE event per message to the frontend. Replay is DB-backed: `_persist_inbox()` writes the `HumanMessage` row *before* the SSE event fires, so a reconnecting client rehydrates the message from `GET /api/team/{session_id}/history` via `parseTeamBlocks` — the stream-store state blob does **not** hold an `inbox_messages` array.
4. Appends each `HumanMessage` to `state.messages` so the **next LLM call sees them in context**.
5. Returns `request.override(messages=tuple(state.messages_for_llm))` — rebuilds `ModelRequest` so the LLM call sees the newly injected messages. This is critical because `ModelRequest.messages` is a frozen tuple snapshot built *before* `before_model` hooks fire; without the override the LLM would see a stale message list.

This means a teammate's `team_message` arriving mid-turn is injected into the *next agent loop iteration*:

```
iteration N:   LLM → tool_calls → tool results → checkpointer.sync()
iteration N+1: TeamInboxHook.before_model() → inbox drained → appended to state.messages
                → returns updated ModelRequest with fresh messages
                LLM call sees new message
```

```python
hook = TeamInboxHook(member=self)  # bound to a TeamMemberBase instance
```

---

## Creating a custom hook

```python
from app.agent.hooks.base import BaseAgentHook
from app.agent.state import AgentState, RunContext, ToolCallHandler
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ToolCall

class AuditHook(BaseAgentHook):
    """Log every tool call name and duration."""

    def __init__(self):
        self._start: dict[str, float] = {}

    async def wrap_tool_call(
        self,
        ctx: RunContext,
        state: AgentState,
        tool_call: ToolCall,
        handler: ToolCallHandler,
    ) -> str:
        import time
        t0 = time.monotonic()
        result = await handler(ctx, state, tool_call)
        elapsed = time.monotonic() - t0
        print(f"[audit] {tool_call.function.name} took {elapsed:.2f}s")
        return result

    async def after_agent(self, ctx: RunContext, state: AgentState, response: AssistantMessage) -> None:
        print(f"[audit] turn complete. total_tokens={state.usage.total_tokens}")
```

**Rules:**
1. Subclass `BaseAgentHook` — only override the methods you need.
2. `wrap_tool_call` **must** `await handler(ctx, state, tool_call)` and return its result.
3. Use `asyncio.Lock` if your hook accesses shared state (parallel tool execution).
4. Never raise inside a hook — exceptions are caught by `_safe_invoke_hooks()` but can discard results unexpectedly. Log and handle internally.
5. Do not persist messages from hooks — use the `Checkpointer` for persistence.

---

## Hook registration paths

| Path | When to use |
|------|-------------|
| `Agent(hooks=[...])` | Always active for every run of this agent |
| `agent.run(hooks=[...])` | Active for this run only; merged with constructor hooks |
| `TeamMemberBase._handle_messages()` | Registers the per-turn hook set; passes `SQLiteCheckpointer` to `agent.run()` |
| `Agent._load_plugin_hooks(role)` | Lazily loads user-authored plugin hooks from `OPENAGENTD_PLUGINS_DIRS` once per `(agent, role)` — see [`plugins.md`](./plugins.md) |

`TeamMemberBase._handle_messages()` builds approximately this hook list per turn (lead vs member differ in a few entries):

```python
[
    inject_current_date,             # date in system prompt
    AgentTeamProtocolHook,           # team protocol injection
    TeamInboxHook,                   # mailbox drain → state.messages
    WikiInjectionHook,               # USER.md / topics injection
    WorkspaceInstructionsHook,       # coding mode only
    SessionLogHook,                  # JSONL per-session log
    OpenTelemetryHook,               # spans + metrics
    StreamPublisherHook,             # SSE event publishing
    ToolResultOffloadHook,           # large tool result offload
    TitleGenerationHook,             # lead only, first turn
    SummarizationHook,               # built via build_summarization_hook (may be None)
]
```
