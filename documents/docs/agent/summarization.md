---
title: Rolling-Window Context Summarization
description: Automatic conversation compression when context window approaches token threshold.
status: stable
updated: 2026-06-23
---

# Summarization

**Source:** `app/agent/hooks/summarization.py`

`SummarizationHook` implements rolling-window context compression: when the LLM's prompt token count crosses a threshold, older messages are replaced with a compact summary, keeping the context window manageable without losing history.

---

## Design principles

| Property | Detail |
|----------|--------|
| **Pure state transform** | Reads `state.usage.last_prompt_tokens` and mutates `state.messages` directly. No DB access inside the hook. |
| **In-memory trigger** | Token count comes from `state.usage.last_prompt_tokens`, populated by the loop after each LLM call. |
| **Non-destructive** | Old messages are marked `exclude_from_context=True` in-memory; the Checkpointer persists this to DB. Full history remains. |
| **UI transparent** | Summary rows (`is_summary=True`) are never returned to the UI. Users see the full unabridged conversation. |
| **Minimum-delta guard** | `_messages_at_last_summary` tracks the message count at the last summarisation. If fewer than `min_messages_since_last_summary` new messages have arrived, the hook skips — prevents thrashing when the kept window sits close to the threshold. |
| **Tool result preservation** | `ToolMessage` content is sent to the summariser in its original message shape so compaction sees the same conversation prefix as the normal chat request. |
| **Loaded skill retention** | `skill` tool call/result pairs are retained verbatim after compaction, including the assistant `tool_calls` message required by provider ordering rules. This keeps loaded skill instructions active in the same session without requiring another `skill(...)` call. |
| **Cache-first LLM call** | The summariser keeps the normal request prefix, including the actual system prompt after prompt hooks, retained skill tool pairs, and tool definitions, so large compactions reuse the provider's automatic prefix cache already warmed by the conversation turns. It sets **no explicit prompt-cache key** — a session-scoped key would route the summariser to a different cache partition than the normal turns and miss. Only the summary instruction is appended as the final user message. The prompt explicitly asks for summary text only and not tool use, and tells the summariser not to summarize or quote retained skill instruction tool results. |
| **Merge vs. fresh summary** | When the window being summarised contains a prior summary (`is_summary=True`), the hook sends a merge instruction (`_MERGE_REQUEST`) instead of the default request. The summariser is told explicitly to fold old and new content together. |
| **LLM exception** | Calls an LLM to generate the summary text — the only I/O this hook performs. |
| **Inherits ``thinking_level``** | The hook does NOT override ``thinking_level`` on the summariser call — the agent's primary level flows through unchanged. Compaction respects the agent configuration; seed agents already pin a low effort (`thinking_level: low`) which is the right floor. |

---

## Configuration

Summarization has **no operator-facing configuration surface**. All tuning lives as constants in `app/agent/hooks/summarization.py`. There is no per-agent `summarization:` block, no `.openagentd/config/summarization.md` file, and no environment variables. To change anything, edit the source and ship a new build — this guarantees a single source of truth and removes the risk of drift from a stale config file.

### Bundled prompts (selected by session mode)

| Constant | Used when | Shape |
|----------|-----------|-------|
| `CHAT_SUMMARY_PROMPT` | session mode is `normal` (or omitted) | Prose: "produce a concise summary in third-person narrative form…" |
| `CODING_SUMMARY_PROMPT` | session mode is `coding` | Structured Markdown template (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / Relevant Files) — much higher signal density for follow-up turns. |

`build_summarization_hook` selects the prompt via `prompt_for_mode(mode)`. The team member call site (`app/agent/mode/team/member.py`) passes `mode=self._team.mode`.

### Mode-aware keep window

`keep_last_assistants` is **also** mode-aware, via `keep_last_for_mode(mode)`:

| Mode | Constant | Value | Rationale |
|------|----------|-------|-----------|
| `normal` (default) | `DEFAULT_KEEP_LAST_ASSISTANTS` | `3` | Preserve recent conversational context verbatim so the next reply stays grounded in the most recent exchanges. |
| `coding` | `CODING_KEEP_LAST_ASSISTANTS` | `0` | Compact **everything** below the threshold into the structured summary. Coding sessions benefit from a single authoritative "state of the world" record over partially-summarised history. |

### Module-level defaults (single source of truth)

The trigger threshold is model-aware when the model registry has a `limits.context_length` entry for the agent model. Registry data comes from the bundled `app/agent/providers/model_registry.json`, refreshed `models.dev` cache, and optional user overlay:

```text
threshold = min(MAX_PROMPT_TOKEN_THRESHOLD, 75% of model context length)
```

Unknown model context lengths fall back to `DEFAULT_PROMPT_TOKEN_THRESHOLD`. API surfaces that need to display the trigger should use the backend-calculated value (`summary_trigger_tokens` on `/api/team/agents` and `/api/agents/registry`) instead of hardcoding the fallback.

| Constant | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_PROMPT_TOKEN_THRESHOLD` | see code | Fallback trigger threshold for `state.usage.last_prompt_tokens` when model context is unknown. Set to `0` to disable summarization entirely. |
| `MAX_PROMPT_TOKEN_THRESHOLD` | see code | Upper bound for model-aware summarization thresholds. |
| `PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO` | `0.75` | Fraction of known model context used before applying the max cap. |
| `DEFAULT_KEEP_LAST_ASSISTANTS` | `3` | Chat-mode keep window. |
| `CODING_KEEP_LAST_ASSISTANTS` | `0` | Coding-mode keep window. |
| `DEFAULT_MAX_TOKEN_LENGTH` | `30000` | Cap on the summariser LLM response length. `0` = unlimited. |
| `DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY` | `4` | Skip if fewer than N new messages since the last summarisation — prevents thrashing when the kept window sits close to the threshold. |

### Factory call

`build_summarization_hook` takes the agent's own LLM provider (used as the summariser too — no separate summariser model), the session mode, and the agent `provider:model` ID used for model-aware threshold lookup.

```python
from app.agent.hooks.summarization import build_summarization_hook

hook = build_summarization_hook(
    default_provider=provider,
    mode=team.mode,             # "coding" → CODING_SUMMARY_PROMPT + keep=0; else CHAT_SUMMARY_PROMPT + keep=3
    model_id=agent.model_id,    # e.g. "openai:gpt-5"; threshold = min(max threshold, 75% context)
)
if hook:
    hooks.append(hook)
```

Returns `None` only when `DEFAULT_PROMPT_TOKEN_THRESHOLD <= 0` — the operator-level kill switch.

To construct `SummarizationHook` directly (e.g. for custom integrations), pass any non-empty prompt string and your own numeric tuning:

```python
from app.agent.hooks.summarization import (
    SummarizationHook,
    CHAT_SUMMARY_PROMPT,
    CODING_SUMMARY_PROMPT,
)

hook = SummarizationHook(
    llm_provider=provider,                    # can be a cheaper/faster model
    summary_prompt=CHAT_SUMMARY_PROMPT,        # or CODING_SUMMARY_PROMPT, or a custom string
    prompt_token_threshold=DEFAULT_PROMPT_TOKEN_THRESHOLD,
    keep_last_assistants=3,                   # 0 = summarise everything below threshold
    max_token_length=30000,                   # 0 = unlimited
    min_messages_since_last_summary=4,
)
```

No `session_factory` — the hook does not open DB sessions.

### max_token_length parameter

The `max_token_length` parameter limits the number of tokens in the summarization LLM's response. This is passed to the provider's API as:

| Provider | API Parameter |
|----------|---------------|
| OpenAI | `max_output_tokens` |
| Google Gemini / VertexAI | `max_output_tokens` |
| ZAI | `max_tokens` |
| Copilot | `max_output_tokens` |

**Benefits:**
- **Cost control** — Limits summarization response size and API costs
- **Latency reduction** — Prevents runaway summarization calls
- **Provider-agnostic** — Works with all supported LLM providers
- **Server-side enforcement** — No truncation in our code; the API handles the limit
- **Model-aware capping** — Automatically capped to `min(DEFAULT_MAX_TOKEN_LENGTH, limits.max_completion_tokens)` (e.g. 8192 for Claude 3.5 Sonnet) when the model's limits are known. This prevents `400 Bad Request` or `ValidationException` errors on providers like Anthropic and Bedrock.

Set to `0` to disable (no limit). Default is `30000` tokens.

---

## Trigger flow

```
before_model(ctx, state)
│
├─ threshold <= 0? → skip
│
├─ state.usage.last_prompt_tokens < threshold? → skip
│
├─ too few new messages since last summary? → skip
│
└─ mark summarization pending

wrap_model_call(ctx, state, request)
│
├─ earlier prompt wrappers have produced the final normal system prompt
│  (date, memory, team protocol, workspace instructions, etc.)
│
└─ _summarise(state, system_prompt=request.system_prompt)
     ├─ messages = [m for m in state.messages if not m.exclude_from_context and not isinstance(m, SystemMessage)]
     ├─ find cutoff: walk backward, count assistant messages
     │    cutoff = index of Nth-from-last assistant message (keep_last_assistants)
     │    to_summarise = messages[:cutoff]
     │    to_keep      = messages[cutoff:]      (last N assistant turns + context)
     │    if fewer than N assistant turns exist → to_summarise = all messages
     │
     ├─ Detect retained skill context:
     │    assistant tool_calls where function.name == "skill" + matching ToolMessage
     │    are preserved as provider-valid pairs
     │
     ├─ Build summariser request from the normal cacheable prefix:
     │  final system prompt + selected messages + trailing summary-only user instruction
     │  (retained skill messages stay in their original positions here so the
     │   summarization step shares the same prefix as the overflowing chat request)
     │
     ├─ _call_llm(summariser_messages) → summary_text
     │
     ├─ Mark to_summarise messages: exclude_from_context=True (in-place mutation),
     │  except retained skill pairs, which remain visible
     │
     ├─ Exclude any prior is_summary=True messages still in kept window (superseded)
     │
     ├─ Create HumanMessage("[Summary of earlier conversation]\n" + summary_text, is_summary=True)
     │
     └─ Insert summary after retained skill pairs, otherwise at first non-excluded position
          → state.messages is now updated in-memory
          → wrapper forwards a fresh ModelRequest with state.messages_for_llm
          → loop syncs the updated state to DB
```

---

## Message lifecycle

```
Turn 1–20:  All messages in state.messages, accumulating prompt tokens
Turn 21:    state.usage.last_prompt_tokens ≥ threshold
            → before_model marks summarization pending
            → wrap_model_call fires summarization after prompt wrappers
            → Cutoff = index of 3rd-from-last assistant message (keep_last_assistants=3)
            → Older messages: exclude_from_context=True (mutated in state.messages)
            → Last 3 assistant turns + preceding context: remain included
            → New summary HumanMessage inserted: is_summary=True
            → checkpointer.sync() persists all changes to DB

LLM context from Turn 21 onward (via state.messages_for_llm):
  [system]
  [assistant: skill tool_call]      # only when a skill was loaded before compaction
  [tool: skill instruction body]   # retained verbatim so the skill remains active
  [user: [Summary of earlier conversation]\n...]
  [last 3 assistant turns + context verbatim]
  [new user message]
```

---

## messages_for_llm behaviour

`state.messages_for_llm` is a computed property that filters `state.messages`:

The loop sends `state.messages_for_llm` to the LLM (see `app/agent/state.py:AgentState.messages_for_llm`) — never raw `state.messages`. Multiple summarization rounds work correctly: only the latest summary is included; older summaries are excluded by `exclude_from_context=True` set during the next summarization cycle.

Loaded skills are the intentional exception to "old messages get hidden": `skill` assistant/tool-result pairs remain visible across compactions. The assistant tool-call row is kept with the tool result because providers require tool results to follow a matching assistant `tool_calls` message. Multiple loaded skills are preserved independently; unrelated tool results continue to be summarized and hidden.

## Prompt-cache preservation

Compaction is deliberately shaped like the normal chat request that just crossed
the threshold. The summarizer request is:

```text
[same final system prompt]
[same provider-visible message prefix, including retained skill tool pairs]
[one extra user message: summarization request + bundled summary prompt]
```

The hook does not flatten history into a transcript and does not remove skill
instruction tool results from the summarizer input. That means the summarization
LLM call can hit the provider's automatic prefix cache for the already-warmed
conversation prefix. Skill instructions are still present for cache continuity,
but the bundled summary prompts tell the summarizer not to quote or paraphrase
those instruction bodies.

Manual verification lives in `manual.compaction_cache --direct`. It runs two
compactions, loads two skills, adds a non-skill tool result, and asserts that:

- both summarizer calls share the normal request prefix shape;
- both skill tool results remain in the provider-visible context after repeated
  compaction;
- the non-skill tool result is compacted;
- the generated summary is forwarded into the next model request.

---

## DB schema

| Column | Value after summarization |
|--------|--------------------------|
| `exclude_from_context` | `True` for summarised messages (persisted by `checkpointer.sync()`) |
| `is_summary` | `True` for the summary message |
| `role` | `user` for summary (`HumanMessage` — keeps `system → user → ...` invariant valid for all providers including ZAI). Retained skill context keeps its original `assistant` tool-call row plus `tool` result row. |
| `extra.usage` | Token counts written by `checkpointer.sync()` — read back as `state.usage.last_prompt_tokens` on next turn |

---

## Using a different model for summarization

`build_summarization_hook` always reuses the agent's own LLM provider as the summariser. There is no operator-facing way to point summarisation at a cheaper/faster model.

If you need a different summariser for a custom integration, construct `SummarizationHook` directly with an arbitrary `LLMProviderBase`:

```python
summarizer_provider = ZAIProvider(api_key="...", model="glm-4-flash")
main_provider = GoogleGenAIProvider(api_key="...", model="gemini-2.0-flash")

hook = SummarizationHook(
    llm_provider=summarizer_provider,   # cheap summarizer
    summary_prompt=CHAT_SUMMARY_PROMPT,
    prompt_token_threshold=DEFAULT_PROMPT_TOKEN_THRESHOLD,
)
agent = Agent(llm_provider=main_provider, hooks=[hook])
```

The factory path stays simple on purpose: one knob (`mode`) drives both the prompt and the keep window.

---

## Disabling summarization

Set `DEFAULT_PROMPT_TOKEN_THRESHOLD = 0` in `app/agent/hooks/summarization.py` and rebuild. `build_summarization_hook` returns `None` and the hook is never attached. There is no per-agent or per-session disable knob.

---

## Observability

`SummarizationHook` emits OTel spans directly (it bypasses `OpenTelemetryHook` because it calls the LLM outside the agent hook lifecycle).

### Span hierarchy

```
summarization                   ← _summarise(); parent = active agent_run span if present
  └── summarization_llm_call    ← _call_llm(); the streaming LLM request
```

### `summarization` span attributes

| Attribute | Value |
|-----------|-------|
| `gen_ai.agent.name` | agent name |
| `gen_ai.conversation.id` | session_id |
| `run_id` | unique per turn |
| `summarization.prompt_tokens` | `state.usage.last_prompt_tokens` at trigger time |
| `summarization.threshold` | configured token threshold |
| `summarization.messages_to_summarise` | messages being compressed |
| `summarization.keep_last_assistants` | configured keep window |
| `summarization.summary_length` | char length of generated summary |
| `summarization.kept` | messages kept verbatim |
| `summarization.skipped` | reason if no LLM call was made (`"no_messages"`, `"all_in_keep_window"`, `"empty_llm_response"`) |
| `error.type` | exception class name (only on error) |

### `summarization_llm_call` span attributes

| Attribute | Value |
|-----------|-------|
| `summarization.llm_duration_s` | elapsed seconds for the streaming call |
| `summarization.response_length` | char length of the raw LLM response |
| `error.type` | exception class name (only on error) |

Inspect with:

```bash
uv run python -m manual.otel_inspect --summary          # [summarize] rows in duration table
uv run python -m manual.otel_inspect --op summarization # raw span list
```

---

## Failure modes

| Failure | Behaviour |
|---------|-----------|
| LLM summarization call fails | Logs error, returns without mutating state. Next turn re-evaluates. |
| Empty summary response | Logs warning, skips. Messages remain included. |
| No eligible messages in state | Logs debug, skips. |
| `last_prompt_tokens` is 0 | Hook is silently a no-op (no LLM call yet this turn). Happens on the first turn of a fresh session — tokens are seeded from history on resume (see below). |
| SystemMessage in summary | **Fixed.** `eligible` now excludes `isinstance(m, SystemMessage)` — the agent's system prompt is never passed to the summariser LLM. Team members are also protected since the system prompt is injected by the agent loop into `state.messages` (not DB), and the fix applies uniformly. |
| Too few new messages since last summary | `_messages_at_last_summary` guard logs debug and skips. Prevents thrashing when the kept window already sits close to the threshold. |

---

## Cross-request token seeding (session resume)

`state.usage.last_prompt_tokens` starts at `0` on every new `Agent.run()` call. Without seeding, the hook would never fire on turn 2+ of a multi-HTTP-request session because `before_model` always sees `0`.

**Fix:** Seeding is centralised in `SQLiteCheckpointer` — no call-site workarounds needed.

```
mark_loaded(session_id, history)
  → _last_prompt_tokens_from_history(history)
       scans history in reverse for last assistant extra.usage.input
       stores result in _seeded_tokens[session_id]

agent_loop/core.py — after building AgentState:
  if checkpointer has seed_state:
      checkpointer.seed_state(session_id, state)
          → state.usage.last_prompt_tokens = _seeded_tokens[session_id]
```

Both the single-agent path (`POST /api/chat`) and the team member path (`member.py._handle_messages`) call `mark_loaded()` then pass the checkpointer to `agent.run()`. The loop calls `seed_state()` automatically — both paths get correct seeding with no extra code per call site.

`_last_prompt_tokens_from_history` is a module-level helper in `checkpointer.py` that extracts the last prompt token count from the message history (see `app/services/checkpointer.py`).

---

## HumanMessage exclusion (checkpointer fix)

Prior to this fix, `SummarizationHook` marked all summarised messages (`to_summarise`) as `exclude_from_context=True` in-memory, but the `SQLiteCheckpointer._update_exclude_flags()` method only persisted this flag for `AssistantMessage` and `ToolMessage`. `HumanMessage` exclusions were silently dropped, leaving orphaned user messages visible to the LLM without their paired assistant replies.

**Fix:** `_update_exclude_flags` now processes all message types except `SystemMessage`. `HumanMessage` objects are also registered into `persisted_ids` during `sync()` (without a DB insert — the route handler already saved them) so the flag-flip tracking works correctly on subsequent turns.

`db_id` is now populated on all message types during `_deserialize_messages()`, enabling reliable PK-based DB lookups instead of fragile content-match fallback.

---

## Interaction with teams

`SummarizationHook` is attached to each `TeamMemberBase` (lead or member) independently in `_handle_messages()`. Each agent has its own `AgentState` and its own `state.usage.last_prompt_tokens` accumulation. Summarization fires per-agent when that agent's prompt tokens exceed the threshold — not globally across the team. Each agent's `SQLiteCheckpointer` persists the resulting state mutations independently.

All members share the same tuning (the module-level defaults). The only per-team variation is the session `mode` — which is the same value for every member of a given team because it is set at team construction time and read from `self._team.mode` in `member.py`. So within a team all members use the same prompt + keep window; coding teams summarise everything below the threshold, chat teams keep the last three assistant turns verbatim.

Token seeding on team member resume works identically to single-agent: `mark_loaded()` + `seed_state()` are called inside `_handle_messages()` before every `agent.run()`, so each member wakes up with the correct prior token count regardless of which HTTP request triggered the turn.
