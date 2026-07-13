---
title: Agent Loop & Execution
description: One-turn reasoning loop with iteration, tool dispatch, checkpointing, recovery, and interrupts.
status: stable
updated: 2026-06-26
---

# Agent Loop

**Sources:** `app/agent/agent_loop/core.py` (Agent class), `app/agent/agent_loop/streaming.py`, `app/agent/agent_loop/retry.py`, `app/agent/agent_loop/tool_dispatch.py`

The `Agent` class drives all LLM reasoning in openagentd. One `Agent.run()` call = one user turn.

---

## Construction

```python
from app.agent.agent_loop import Agent
from app.agent.providers.googlegenai import GoogleGenAIProvider

provider = GoogleGenAIProvider(api_key="...", model="gemini-2.0-flash")

agent = Agent(
    llm_provider=provider,
    name="assistant",
    system_prompt="You are a helpful assistant.",
    tools=[web_search, date],
    hooks=[StreamingHook()],
    max_iterations=5000,
    max_concurrent_tools=10,
)
```

| Parameter | Default | Notes |
|-----------|---------|-------|
| `llm_provider` | required | Any `LLMProviderBase` implementation |
| `name` | `"Agent"` | Appears in SSE `agent` field and logs |
| `description` | `None` | Optional description — surfaced on `GET /api/agents` and in the UI |
| `system_prompt` | `"You are a helpful assistant."` | Stored in `state.system_prompt`; prepended as `SystemMessage` inside `_stream_and_assemble` per LLM call |
| `tools` | `[]` | `Tool` objects or plain callables decorated with `@tool` |
| `skills` | `[]` | Skill names advertised in the system prompt; loaded on demand via the `skill` tool |
| `mcp_servers` | `[]` | MCP server names the agent was configured with (surfaced to the UI even when zero tools are ready) |
| `hooks` | `[]` | `BaseAgentHook` instances — run in order |
| `max_iterations` | `5000` (`MAX_AGENT_ITERATIONS`) | Guards against infinite tool-call loops; high enough for long autonomous tasks |
| `max_concurrent_tools` | `10` (`MAX_CONCURRENT_TOOLS`) | Semaphore for parallel tool execution |
| `context` | `None` | Optional `AgentContext` subclass; accessible as `state.context` in hooks |
| `model_id` | `None` | `"provider:model"` string used for capability lookup (`get_capabilities`) and logs |

---

## Running a turn

```python
from app.agent.schemas.agent import RunConfig

config = RunConfig(session_id=str(session_id))
messages = await get_messages_for_llm(db, session_id)
checkpointer = SQLiteCheckpointer(session_factory)
result_messages = await agent.run(messages, config=config, checkpointer=checkpointer)
```

`agent.run()` signature:

```python
async def run(
    messages: list[ChatMessage],
    config: RunConfig | None = None,
    *,
    hooks: Sequence[AgentHook] | None = None,
    injected_tools: list[Tool] | None = None,
    interrupt_event: asyncio.Event | None = None,
    checkpointer: Checkpointer | None = None,
    **kwargs,
) -> list[ChatMessage]:
```

- `hooks` and `injected_tools` are **merged** with constructor values — never replace them.
- `messages` is copied; the caller's list is never mutated.
- Returns the full message list including new assistant + tool messages appended this turn.
- Pass `checkpointer=None` (default) to skip all persistence — useful for unit tests.

See `app/agent/agent_loop/core.py:Agent.__init__` and `Agent.run()` for full signature details.

---

## Loop internals

```
agent.run(messages, checkpointer=checkpointer)
│
├─ Create RunContext(session_id, run_id, agent_name, session_created_at)   ← frozen, immutable
├─ Strip any SystemMessage from input messages         ← system prompt never lives in state.messages
├─ Build AgentState(messages, capabilities, tool_names, ...)  ← mutable, per-run
├─ Build tool hook chain (build_tool_chain)
│
├─ Fire before_agent(ctx, state) on all hooks
│
└─ while iteration < max_iterations:
    ├─ Build ModelRequest(messages=state.messages_for_llm, system_prompt=state.system_prompt)
    │
    ├─ Fire before_model(ctx, state, request) on all hooks
    │    ├─ TeamInboxHook (team only): drains mailbox queue, persists + SSE-emits new inbox
    │    │  messages, appends them to state.messages, returns updated ModelRequest
    │    └─ Hook may return modified ModelRequest (e.g. SummarizationHook, TeamInboxHook)
    │       ModelRequest.messages is a frozen tuple snapshot — hooks that mutate
    │       state.messages MUST return request.override(messages=...) or the LLM sees stale data
    │
    ├─ checkpointer.sync(ctx, state)                   ← sync point 1: after before_model
    │
    ├─ build_model_chain → invoke wrap_model_call chain with model_request
    │    ├─ On exhausted-retry ReadTimeout/ConnectError: resume same turn (≤3) after backoff
    │    └─ Innermost: _stream_and_assemble(req, ctx, state, hooks, interrupt_event, tool_defs)
    │         ├─ Prepends SystemMessage(req.system_prompt) at index 0 for provider call
    │         ├─ _stream_with_retry(messages=[SystemMessage, ...req.messages], tools=tool_defs|None)
    │         │    └─ llm_provider.stream(...)  — yields ChatCompletionChunk
                │         ├─ Fire on_model_delta(ctx, state, chunk) per chunk
                │         │    ├─ StreamingHook queues chunk to asyncio.Queue
                │         │    └─ StreamPublisherHook pushes thinking/message/tool_call to stream store
    │         ├─ Buffers: full_content, reasoning, tool_calls_buffer (indexed by tc.index)
    │         └─ Returns AssistantMessage; stores usage in self._last_usage
    │
    ├─ Read self._last_usage; populate state.usage (last_prompt_tokens, total_tokens, …)
    ├─ Fire after_model(ctx, state, assistant_msg)
    │    └─ SessionLogHook writes JSONL event
    │
    ├─ checkpointer.sync(ctx, state)                   ← sync point 2: after after_model
    │
    ├─ If previous message is ToolMessage and assistant payload is empty
    │    └─ Continue automatically up to 3 times, then fall through
    ├─ If no tool_calls → BREAK (final answer)
    │
    ├─ ★ Pre-dispatch interrupt check
    │    └─ If interrupt_event.is_set(): append ToolMessage("Cancelled by user.") per tool call → BREAK
    │
    ├─ _gather_or_cancel([_run_tool(ctx, state, tc) for tc in tc_list], interrupt_event)
    │    ├─ Each tool: semaphore-bounded → tool hook chain → execute_fn
                │    │    ├─ StreamingHook.wrap_tool_call: queue ToolStartSignal, execute, queue ToolEndSignal
                │    │    └─ StreamPublisherHook.wrap_tool_call: push tool_start, execute with optional output deltas, push tool_end
    │    └─ On interrupt mid-execution:
    │         ├─ Completed tools keep their real results
    │         ├─ Still-running tools are cancelled → ToolMessage("Cancelled by user.")
    │         └─ Loop breaks after appending all ToolMessages
    │
    ├─ Append ToolMessage per result (if tool returned ToolResult → attach .parts)
    ├─ checkpointer.sync(ctx, state)                   ← sync point 3: after tool execution
    └─ loop
│
├─ Fire after_agent(ctx, state, last_assistant_msg)
│    └─ StreamingHook puts _SENTINEL → SSE consumer raises StopAsyncIteration
│
└─ checkpointer.sync(ctx, state)                       ← sync point 4: after after_agent
```

---

## Tool call buffering

The loop buffers streaming tool-call deltas by `tc.index` — providers stream arguments incrementally, with `.id` set on first appearance and never overwritten (see `app/agent/agent_loop/core.py:155-170`).

**Critical:** `id` is set on first appearance and never overwritten. Some providers resend IDs on continuation chunks — overwriting causes `tool_end` to carry the wrong ID downstream.

**Provider contract — `.index` must be stable per `id`.** The buffer is keyed by `idx`, so a provider that changes the index of an already-seen id between chunks will trigger the `tool_call_index_collision` warning (`app/agent/agent_loop/streaming.py:121`) and leak a duplicate pending tool card onto the UI (`StreamPublisherHook.on_model_delta` emits a second `tool_call` SSE event for the new id, and that card never receives `tool_start`/`tool_end`). Gemini SSE chunks carry a complete snapshot of the candidate's `parts` array every chunk, so naive `enumerate(parts)` indexing breaks this contract when a `thought` part shifts positions mid-stream. `googlegenai.py` assigns a stream-scoped `tool_idx_by_id.setdefault(fc_id, len(tool_idx_by_id))` before building each `ToolCallDelta`, guaranteeing the same id keeps the same slot across chunks.

---

## Retry logic

`_stream_with_retry()` wraps the provider call with exponential-backoff retry:

| Status | Behaviour |
|--------|-----------|
| `429 Too Many Requests` | Parse `Retry-After`; retry only when delay is under 60s, otherwise raise |
| `500 / 502 / 503 / 504` | Retry with exponential backoff |
| `401 / 403` | Classify into `ProviderAuthenticationError` and raise — credentials are missing/expired/rejected |
| `400 / 404 / 422 / other 4xx` | Classify into `ProviderRequestError` (carrying the provider's own error message) and raise — malformed request won't self-heal |
| `ConnectError / ReadTimeout` | Retry |

Non-retryable HTTP errors are passed through `classify_provider_http_error()`,
which reads the response body to recover the provider's own explanation (OpenAI
`{"error": {"message": …}}` and Google GenAI shapes) and wraps it in a typed
domain error. The original `httpx.HTTPStatusError` is preserved as `__cause__`.
This turns an opaque `400 Bad Request` into an actionable message (bad model,
unsupported parameter, context too long, …) that the UI renders directly.

Retry schedule: `min(1 × 3^attempt, 60)` seconds (1s, 3s, 9s, 27s, 60s). On the **last** attempt, no sleep — immediately raise. For `429`, a computed delay of 60 seconds or more also skips the remaining retries and raises.

On `429`, fires `on_rate_limit(ctx, state, retry_after, attempt, max_attempts)` on all hooks before any retry sleep, so `StreamingHook` can push a `rate_limit` SSE event to the client.

## Empty-after-tool recovery

Some providers can return an empty assistant message immediately after a tool
result (`content_len=0`, `reasoning_len=0`, `tool_calls=0`). Treating that as a
final response makes the lead appear to stop silently after the tool call. When
the previous message is a `ToolMessage` and the assistant payload is empty, the
loop now continues the same turn automatically instead of appending the empty
assistant message.

This recovery is bounded to three consecutive empty-after-tool responses. If the
limit is reached, the loop falls back to the normal final-response path so a
persistently empty provider cannot spin forever. This is separate from the
user-facing `/continue` command; it is an automatic within-turn retry.

Log events:

| Log event | Level | Meaning |
|-----------|-------|---------|
| `agent_empty_after_tool_continue` | WARNING | Empty assistant payload after a tool result; the loop starts another iteration in the same turn. |
| `agent_empty_after_tool_limit` | WARNING | Empty-after-tool recovery hit the three-attempt limit and falls through to the normal final-response path. |

## Provider-timeout resume

The retry layer ([above](#retry-logic)) handles transient errors
*within* a single model call. When the provider exhausts its retry budget on a
connectivity failure (`ReadTimeout` / `ConnectError`), the exception used to
propagate straight out of `run()` —
ending the turn mid-task and abandoning all tool work already completed in that
turn. This is the most common "the agent stopped after a tool call" symptom on
slow or flaky model endpoints.

The loop now catches that exhausted-retry failure around the model call and
**resumes the same turn**: it waits a short linear backoff, then re-issues the
model call with the identical message history (work-so-far is already persisted
by the post-tool checkpointer sync), so the model continues from exactly where
it left off. The interrupt event is honoured during the backoff — a user Stop
ends the turn instead of resuming.

Resume is bounded by `MAX_PROVIDER_RESUME_ATTEMPTS` (3). After the budget is
exhausted the failure is wrapped in a typed `ProviderConnectionError` (carrying
the underlying transport `error_type` and provider label) and raised, so a
persistently dead endpoint cannot loop forever and the UI can explain *why* the
provider was unreachable. A successful model call resets the budget, so
unrelated hiccups later in the same turn each get the full allowance.

> The raw `ReadTimeout` / `ConnectError` is intentionally **not** wrapped inside
> the retry layer — the resume loop must still catch the bare transport error.
> Only this terminal, budget-exhausted raise produces the typed error.

| Log event | Level | Meaning |
|-----------|-------|---------|
| `agent_provider_resume` | WARNING | Provider exhausted its retry budget on a transient failure; the loop will retry the same turn after a backoff. |
| `agent_provider_resume_exhausted` | ERROR | Resume budget exhausted; the failure is wrapped in `ProviderConnectionError` and raised, ending the turn. |

## Max-tokens truncation recovery

When a model hits its output token limit (`finish_reason="max_tokens"` or `"length"`), it is cut off mid-sentence or mid-action. This is especially problematic during tool calls (like writing or patching files) because the JSON payload becomes truncated and malformed, resulting in the tool call being dropped.

To minimize truncation, the agent loop dynamically resolves the maximum output token limit (`max_tokens`) for each model from the central model registry (`models.dev`). For example, newer models like Claude 4+ natively support up to 128k output tokens, which are resolved dynamically. For models without a registered limit, or legacy models (such as Claude 3.5 and Claude 3.7, which do not use beta headers), the provider defaults to 4k (4,096 tokens).

The loop handles truncation by:
1. **Detecting Truncation:** Checking if `finish_reason` is `"max_tokens"` or `"length"`.
2. **Identifying Dropped Tool Calls:** The streaming assembler tracks if a partial tool call was dropped due to bad JSON or missing names during truncation (`dropped_tool_calls`).
3. **Injecting a Recovery Prompt:**
   - If a tool call was dropped, it appends a `HumanMessage` to the message history informing the agent: *"Error: Your tool call was truncated and could not be executed because you exceeded the maximum output token limit (max_tokens). Please retry by breaking the task into smaller steps, or use a more precise tool (like edit/patch instead of writing/patching a huge block)."*
   - If it was a text response that got cut off, it appends a `HumanMessage` asking the agent to continue its response from where it left off.
4. **Continuing the Turn:** The loop continues to the next iteration to let the agent respond/recover immediately.

This allows the agent to self-heal and adapt its behavior (e.g. switching to smaller, more precise edits or writing in chunks) rather than stopping mid-process.

Log events:

| Log event | Level | Meaning |
|-----------|-------|---------|
| `agent_response_truncated` | WARNING | The response was truncated by the provider due to output token limits; the loop injects a recovery prompt and continues the turn. |

### Key log events (retry)

| Log event | Level | Meaning |
|-----------|-------|---------|
| `llm_provider_retry` | WARNING | Retrying after a transient error (includes model, status, attempt, delay) |
| `llm_provider_non_retryable_rate_limit` | WARNING | Quota-style 429 detected; retry skipped for that provider |
| `llm_provider_exhausted` | WARNING | All retry attempts exhausted for a provider |
| `llm_provider_error` | ERROR | Non-retryable error — raised immediately |

---

## Interrupt

Pass an `asyncio.Event` as `interrupt_event`. The loop checks it at four points:

1. **Top of each iteration** — observed before the next `before_model` / LLM call, so an interrupt that fires between iterations (e.g. while `after_model` hooks ran, or between tool dispatch and the next model call) breaks the loop immediately instead of letting another LLM call start.
2. **During LLM streaming** — each chunk read is awaited concurrently with `interrupt_event.wait()` via the `_interruptible_stream` wrapper in `app/agent/agent_loop/streaming.py`. When the event wins the race, the in-flight `__anext__` task is cancelled and `aclose()` is called on the upstream generator — that cascades through the provider's `async with httpx.AsyncClient` block so the socket is closed instead of waiting on the next SSE event. A long mid-stream pause (e.g. Gemini extended-thinking) no longer hides the user's stop request. **Providers with `support_interrupt = False` opt out of this check** — their stream always runs to completion before the loop observes the event (see [Non-interruptible providers](#non-interruptible-providers) below).
3. **Before tool dispatch** — if already set when tools are about to execute, skips execution entirely and returns `"Cancelled by user."` for every tool call.
4. **During tool execution** — `_gather_or_cancel()` monitors the event while tools run in parallel. Completed tools keep their real results; still-running tools receive `asyncio.Task.cancel()`. Tasks that stop are recorded as `"Cancelled by user."`; cancellation-resistant tasks are retained until they exit and reported as still stopping.

```python
interrupt = asyncio.Event()
task = asyncio.create_task(agent.run(messages, interrupt_event=interrupt))
interrupt.set()   # cancel mid-stream or mid-tool-execution
```

Team members use this for user-initiated interrupts. After the run, the last assistant message is annotated with `" [interrupted]"` in the DB.

### Non-interruptible providers

Some providers use stateful or quota-tracked streaming connections (e.g. proxy-based providers like `agy`) where cutting an in-flight request mid-stream wastes a quota slot or leaves the connection in a bad state. These providers set `support_interrupt = False` on their `LLMProviderBase` subclass:

```python
class MyProxyProvider(LLMProviderBase):
    support_interrupt = False
    ...
```

When `support_interrupt = False`, `stream_and_assemble` passes `interrupt_event=None` to both `_interruptible_stream` and `stream_with_retry`, so the current LLM call always completes in full. The interrupt is still observed at points 1, 3, and 4 above — the loop exits cleanly at the **next between-iteration boundary**, tools are still cancelled, and the net latency difference is at most one LLM call's streaming time.

Team queued follow-ups follow the same rule: they are not spliced into a running lead loop by `QueuedMessageInjectionHook` for non-interruptible providers. The queued rows stay persisted with `extra.queue_status="queued"` and are activated by the normal after-loop queue handoff once the lead activation returns to `idle`.

The default is `True` (all built-in providers are interruptible).

### `_gather_or_cancel` — cancellable parallel tool execution

`_gather_or_cancel(coros, interrupt_event, tc_list)` replaces the previous `asyncio.gather()` call. It uses `asyncio.wait(FIRST_COMPLETED)` in a loop, racing tool tasks against the interrupt event:

```
Tool A (fast)  ──── done ✓  real result kept
Tool B (medium) ─────── done ✓  finished same tick as cancel — real result kept
Tool C (slow)   ──────────── CANCEL ✗  "Cancelled by user."
                                  ↑
                           interrupt_event.set()
```

When `interrupt_event` is `None`, falls back to plain `asyncio.gather(..., return_exceptions=True)` — zero overhead for non-interruptible runs.

Cancellation is cooperative for arbitrary in-process Python tools: a tool may
catch `CancelledError`, block in a thread or native call, or have already sent a
remote operation. The dispatcher waits briefly, retains any task that is still
stopping, and does not claim that its side effects were cancelled. Built-in
foreground shell commands are stronger: OpenAgentd owns their subprocess group,
kills it on cancellation, and waits for it to exit. Remote MCP/API operations
can only be guaranteed to stop when the remote service supports cancellation.

### HTTP-layer interrupt (team mode)

`POST /api/team/chat` with `interrupt=true` triggers the interrupt via team interrupt handling:

```
POST /api/team/chat  interrupt=true  session_id=<sid>
│
├─ AgentTeam interrupts current member run
│    └─ interrupt_event.set()     ← loop breaks after current chunk or cancels tools
├─ Cancel and await direct `!command` tasks owned by this session
└─ return {"status": "interrupted", "session_id": "..."}
```

The checkpointer (`SQLiteCheckpointer`) has already saved partial output at the most recent `sync()` call — no assistant text is lost. Empty assistant messages (interrupted before any content, reasoning, or tool calls were generated) are skipped during `sync()` to avoid persisting no-op rows. Once the loop exits, the SSE stream emits a final `done` event with `cancelled: true` in metadata, signalling clients to reload from DB.

### Non-graceful interrupt — orphaned tool calls

Sync point 2 (after `after_model`) persists the `AssistantMessage` with `tool_calls` *before* dispatch starts; sync point 3 persists the matching `ToolMessage` rows. A crash, SIGKILL, or uvicorn auto-reload between those two points leaves the assistant turn on disk with no tool replies. The next user turn would then 400 against any provider that enforces the assistant→tool pairing (OpenAI Responses: `"No tool output found for function call …"`).

`AgentTeam.handle_user_message` calls `chat_service.heal_orphaned_tool_calls()` immediately before persisting the new user message. The helper scans the full LLM-visible window, including compacted history (`[latest_summary] + keep_last_n`), and inserts a synthetic `ToolMessage("Tool execution was interrupted before a result could be recorded.")` for any visible `tool_call_id` without a matching visible reply. Rows hidden by `/undo` are ignored so an edited resend cannot resurrect a reverted tool-call branch into the next provider request. Stub timestamps anchor immediately after the owning assistant row so the LLM input order stays `assistant{tool_calls} → tool → … → user` even when wall-clock writes collide. Heal runs in the same transaction as the user-message insert (atomic) and is a no-op when the visible window is healthy. See `app/services/chat_service.py:heal_orphaned_tool_calls` and `tests/services/test_chat_service.py` (`test_heal_*`) for the contract.

A second failure mode occurs when the user stops the agent **during argument streaming** — before the LLM has finished emitting the JSON arguments for a tool call. Two layers of defence apply:

1. **Source-level filter (primary).** `stream_and_assemble` drops any buffered tool call whose `function.name` is empty (the OpenAI Responses API only emits the name on the final `function_call_arguments.done` event) or whose non-empty `function.arguments` fails to parse as JSON, before constructing the `AssistantMessage`. Logged as `drop_partial_tool_call_no_name` / `drop_partial_tool_call_bad_json`. Empty-string arguments are preserved (legitimate no-arg call). Bad data never enters the DB or downstream provider converters — preventing the canonical `Expecting ',' delimiter: line 1 column N` blowup in e.g. the Bedrock `json.loads(tc.function.arguments or "{}")` site.
2. **Deserialize-time backstop.** `_deserialize_messages` in `app/services/chat_service.py` re-validates each `tool_call.function.arguments` with `json.loads` on read; any that fail are silently dropped (with a `deserialize_drop_partial_tool_call` warning) and their paired `ToolMessage` rows are removed. This protects against legacy rows persisted before the source-level filter existed.

---

## Concurrency safety

- `self._tools` is never mutated after construction — `agent.run()` builds a local `run_tools` copy.
- The `_tool_semaphore` (default 10) bounds parallel tool calls.
- `self.state` (`AgentStats`) — cumulative stats object, safe to read between turns.
- `AgentState` — per-run, created fresh each call, not shared between concurrent runs.
- `RunContext` — frozen dataclass, safe to share across concurrent hooks and tool calls.

---

## Key log events

| Log event | Level | Key fields |
|-----------|-------|-----------|
| `agent_run_start` | INFO | `agent`, `message_count`, `tools`, `session` |
| `agent_iteration` | INFO | `agent`, `iteration`, `max_iterations`, `messages` |
| `llm_response` | INFO | `agent`, `iteration`, `elapsed`, `content_len`, `reasoning_len`, `tool_calls`, token counts |
| `llm_usage_detail` | DEBUG | `cached_tokens`, `thoughts_tokens`, `tool_use_tokens` |
| `agent_empty_after_tool_continue` | WARNING | `agent`, `iteration`, `attempt` — empty assistant payload after a tool result; loop continued automatically |
| `agent_empty_after_tool_limit` | WARNING | `agent`, `iteration`, `attempts` — empty-after-tool recovery limit reached; loop fell through to normal final-response handling |
| `agent_provider_resume` | WARNING | `agent`, `iteration`, `attempt`, `error`, `delay` — provider exhausted its retry budget; loop resumes the same turn after a backoff |
| `agent_provider_resume_exhausted` | ERROR | `agent`, `iteration`, `attempts`, `error` — provider-resume budget exhausted; the error is re-raised and the turn ends |
| `agent_stream_restart_reset` | WARNING | `agent`, `dropped_content_len`, `dropped_tool_calls` — a mid-stream retry restarted the provider stream; partial assembly was discarded |
| `tool_dispatch` | INFO | `agent`, `count`, tool names |
| `tool_dispatch_skipped_interrupt` | INFO | `agent`, `count` — interrupt was set before tool execution started |
| `tool_start` | INFO | `agent`, `tool`, `id`, args preview |
| `tool_done` | INFO | `agent`, `tool`, `elapsed`, `result_len` |
| `tool_cancelled` | INFO | `agent`, `tool` — tool was cancelled mid-execution by interrupt |
| `tool_call_orphans_healed` | WARNING | `session_id`, `count`, `ids` — synthetic tool replies inserted before next turn (server crash recovery) |
| `drop_partial_tool_call_no_name` | WARNING | `agent`, `idx`, `args_prefix` — buffered tool call dropped in `stream_and_assemble` because the function name never arrived (mid-stream interrupt) |
| `drop_partial_tool_call_bad_json` | WARNING | `agent`, `idx`, `name`, `args_prefix` — buffered tool call dropped because arguments are truncated / invalid JSON |
| `deserialize_drop_partial_tool_call` | WARNING | `tool`, `id`, `args_prefix` — DB-side backstop: tool call dropped on read because arguments are invalid JSON |
| `tool_error` | ERROR | `agent`, `tool`, `elapsed`, `error` |
| `agent_run_done` | INFO | `agent`, `elapsed`, `iterations`, `total_messages`, `total_tokens` (from `state.usage.total_tokens`) |
