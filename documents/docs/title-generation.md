---
title: Chat Title Generation
description: Automatic LLM-generated session titles with configurable model, wait timeout, graceful degradation.
status: stable
updated: 2026-04-24
---

# Chat Title Generation

> Automatic LLM-generated session titles replacing the raw-truncation fallback.

**Status:** Implemented
**Files:** `app/services/title_service.py`, `app/agent/hooks/title_generation.py`,
`.openagentd/config/settings.yaml`

---

## How it works

1. User sends their first message to a new session.
2. Session is created immediately with `title = message[:100]` as a fallback.
3. `TitleGenerationHook.before_agent()` detects first turn (no `AssistantMessage`
   in `state.messages`). It skips scheduled-task messages, greeting-only inputs,
   and messages shorter than three words; otherwise it spawns title generation.
4. `title_service` calls `provider.chat()` with the built-in title prompt plus
   the user's message (capped at 500 chars), asking for a short title.
5. Title is cleaned (`_clean_title`) and written to `ChatSession.title` in DB.
6. A `title_update` SSE event is pushed to the open stream.
7. `TitleGenerationHook.after_agent()` does a best-effort wait (default 3 s,
   configurable — see below) so `title_update` arrives before the `done` event.
8. The client receives the event, updates the session title in the TanStack
   Query cache in-place (no re-fetch), and animates the title in the sidebar.

Failures at any step are caught and logged — the raw-truncation fallback title
remains. The agent run is never blocked by the LLM call itself.

---

## Configuration — `.openagentd/config/settings.yaml`

Runtime settings live in `settings.yaml`; the title prompt is built in.

```yaml
title_generation:
  enabled: true
  model: <provider>:<model>
  wait_timeout_seconds: 3.0
```

Choose a small, fast model for title generation. The task only needs a short
one-line output, so low latency and low cost matter more than deep reasoning.

### Fields

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `true` | Feature switch. `false` disables title generation with a warning at startup. |
| `model` | selected init model in seeded config; agent's own model if omitted | `provider:model` string for a dedicated title LLM. Prefer a small, fast model. |
| `wait_timeout_seconds` | `3.0` | Best-effort cap (seconds) on how long `after_agent` waits for the background title task before the agent loop completes. Set to `0` for fully non-blocking mode — the title still lands via SSE whenever it's ready. |

### Graceful degradation

Title generation is **soft-required**: if either of the following is true,
`build_title_generation_hook` returns `None` with a `logger.warning` and new
sessions simply keep their raw-truncation fallback title — no exception:

- `enabled: false` in settings.
- `settings.yaml` is invalid.

The prompt is bundled in code.

Path and module defaults live in `app/agent/hooks/title_generation.py`
(`TITLE_GENERATION_PROMPT`, `DEFAULT_WAIT_TIMEOUT_SECONDS`).

---

## Hook: `TitleGenerationHook`

**File:** `app/agent/hooks/title_generation.py`

Title generation is implemented as a standard `BaseAgentHook`. It is added
to the lead agent's hook list (members don't need session titles) via the
`build_title_generation_hook()` factory:

```python
from app.agent.hooks.title_generation import build_title_generation_hook

hook = build_title_generation_hook(
    default_provider=agent.llm_provider,
    db_factory=db_factory,
)
if hook is not None:
    hooks.append(hook)
```

### Detection

`before_agent` checks whether `state.messages` contains any
`AssistantMessage`. If not, this is the first user turn and a title should be
generated. The hook finds the last `HumanMessage` in state and uses its
content.

### Skipped inputs

Sessions created by the scheduler carry a `[Scheduled Task: <name>]` prefix
in the user message (injected by `TaskScheduler._fire_task` before calling
`dispatch_user_message`). `before_agent` detects this prefix and returns
early — no title LLM call is made and no `title_update` SSE event is emitted.

Greeting-only messages such as `hi`, `hello`, `hey`, and `good morning` are
also skipped, as are messages shorter than three words. These sessions keep the
initial fallback title and avoid spending a title-model call on unsummarizable
input.

The reason the check is message-based rather than DB-based: `scheduled_task_name`
is stamped on `ChatSession` *after* `dispatch_user_message` returns, so it is
not yet set when the hook fires. Reading the prefix from the already-present
user message requires no extra DB query.

A `DEBUG`-level log line is emitted when skipped:
```
title_generation_hook_skipped reason=scheduled_task session_id=<uuid>
```

### Background task

The LLM call is fire-and-forget via `asyncio.create_task`. The hook stores
the task handle on `self._task`.

### Ordering guarantee (configurable)

`after_agent` does a best-effort wait on the background task so the
`title_update` SSE event reaches the client before `done` is emitted. The
wait is capped at `wait_timeout` seconds (default 3 s). On timeout or error,
the wait is silently skipped — the title still arrives via SSE whenever the
task finishes.

Set `wait_timeout_seconds: 0` in the config file for fully non-blocking
behavior — the agent loop emits `done` immediately; the `title_update` event
races with reload-on-`done` but TanStack Query in-place patching handles the
merge either way.

---

## LLM call

Best-effort: the cheap path is tried first; on any first-attempt exception
the call is retried once without the `thinking_level` override.

```python
# First attempt — cheap path.
try:
    provider.chat(
        messages=[
            SystemMessage(content=system_prompt),   # from config file body
            HumanMessage(content=user_text),        # capped at 500 chars
        ],
        max_tokens=20,
        thinking_level="none",
    )
# Codex (and any future provider that rejects missing ``reasoning``) →
# retry once with the agent's configured ``thinking_level`` flowing through.
except TimeoutError:
    ...
except Exception:
    provider.chat(
        messages=...,
        max_tokens=20,
        # no thinking_level — inherited from provider's model_kwargs
    )
```

`max_tokens=20` is sufficient — the ≤50 character output cap is at most
~12–13 tokens. The cheap path uses `thinking_level="none"` to skip
reasoning on providers that accept it (OpenAI API-key, ZAI, Gemini, …) —
saving cost and latency on a throwaway call. The Codex
`chatgpt.com/backend-api/codex` endpoint rejects requests with no
`reasoning` field (`ResponsesHandler.customize_thinking` omits it whenever
the level is `"none"`/`"off"`), so the retry path drops the override and
lets the provider's constructor `model_kwargs` supply the agent's
configured level. The retry sets the `title_generation.retried` span
attribute for observability.

Timeout: 15 seconds (inside `title_service`, separate from the hook wait)
applies to **each** attempt independently. On first-attempt timeout the
function returns immediately — no retry — since a slow provider on the
cheap path is unlikely to be faster on the more expensive retry path. On
retry timeout or any retry exception, logs at `warning` and returns —
fallback title stays.

---

## SSE event

```
event: title_update
data: {"type": "title_update", "title": "Japan trip planning"}
```

Pushed after the DB write. Not replayed on reconnect (pub/sub only) — the DB
title is the source of truth after `done`.

---

## Client handling

Both `useChatStore` and `useTeamStore` store `sessionTitle: string | null` in
state. On `title_update`, the store sets `sessionTitle`.

Both route layouts (`chat.tsx`, `cockpit.tsx`) subscribe to the store and patch
the cached session list on `sessionTitle` change. The team session list is an
infinite query, so the cache shape is `InfiniteData<SessionPageResponse>` —
the bridge maps over `pages[*].data`, not the wrapper object. See
`web/src/routes/cockpit.tsx` (`title_update` branch) for the exact patch.

`setQueriesData` patches the cache in-place — no network re-fetch.

The sidebar (`Sidebar.tsx`) animates the title change with framer-motion:

```tsx
<AnimatePresence mode="wait" initial={false}>
  <motion.p
    key={session.title ?? 'untitled'}
    initial={{ opacity: 0, y: -6 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 6 }}
    transition={{ duration: 0.18, ease: 'easeOut' }}
  >
    {session.title || 'Untitled'}
  </motion.p>
</AnimatePresence>
```

`key` change on title → React unmounts old, mounts new → enter/exit animation.
`initial={false}` suppresses animation on first render.

---

## Observability

`generate_and_save_title` emits an OTel span directly. Because it runs as a
fire-and-forget `asyncio.create_task` spawned from
`TitleGenerationHook.before_agent()`, there is no active agent span in
context — the span appears as a root span with `parent_id=null`.

### `title_generation` span attributes

| Attribute | Value |
|-----------|-------|
| `gen_ai.conversation.id` | session_id |
| `title_generation.user_message_length` | chars of user message sent to LLM (capped at 500) |
| `title_generation.llm_duration_s` | elapsed seconds for the `provider.chat()` call |
| `title_generation.title_length` | char length of the cleaned title (only on success) |
| `title_generation.skipped` | reason if title was not saved (`"empty_response"`, `"session_not_found"`) |
| `title_generation.retried` | `True` when the first attempt raised and the call was retried without the `thinking_level` override (e.g. Codex compat) |
| `error.type` | `"TimeoutError"` on timeout, exception class name on LLM error |

Inspect with:

```bash
uv run python -m manual.otel_inspect --summary              # [title_gen] row in duration table
uv run python -m manual.otel_inspect --op title_generation  # raw span list
```

---

## Testing

All title generation logic is covered by unit and integration tests in
`tests/services/test_title_service.py` and
`tests/agent/hooks/test_title_generation_hook.py`. Tests include:

**Unit tests (`_clean_title`):**
- Whitespace and quote stripping
- Trailing punctuation removal
- Truncation to 255 characters
- Edge cases (empty strings, only punctuation, nested quotes)

**Integration tests (`generate_and_save_title`):**
- Happy path: provider returns title, DB saves, event pushed
- Missing/empty `system_prompt` raises `ValueError`
- Message truncation (500 char cap)
- Title cleaning before save
- Provider errors and timeouts → silent return
- Empty/None/whitespace responses → DB unchanged
- Session not found → no event pushed
- Correct cheap-path LLM parameters (`max_tokens=20`, `thinking_level="none"`)
- Retry-without-override when the first attempt raises (Codex compat)
- Event payload structure validation

**Hook tests (`TitleGenerationHook`):**
- First-turn detection / early returns
- Fire-and-forget task spawning with correct kwargs
- `after_agent` waits with configurable timeout; `wait_timeout=0` skips the wait
- Exceptions in the background task are swallowed gracefully

**Testing pattern:** Tests use actual `async_sessionmaker[AsyncSession]`
rather than mocking context managers — `DbFactory` type is strict.

```python
await generate_and_save_title(
    session_id=session_id,
    user_message=message,
    provider=mock_provider,
    db_factory=db_factory,
    system_prompt="test title prompt",
)
```

---

## Deferred

- Re-generation trigger for sessions that significantly change topic after turn 1
