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
`.openagentd/config/title_generation.md`

---

## How it works

1. User sends their first message to a new session.
2. Session is created immediately with `title = message[:100]` as a fallback.
3. `TitleGenerationHook.before_agent()` detects first turn (no `AssistantMessage`
   in `state.messages`) and spawns
   `asyncio.create_task(generate_and_save_title(...))`.
4. `title_service` calls `provider.chat()` with the prompt from
   `.openagentd/config/title_generation.md` plus the user's message (capped at
   500 chars), asking for a 3–6 word title.
5. Title is cleaned (`_clean_title`) and written to `ChatSession.title` in DB.
6. A `title_update` SSE event is pushed to the open stream.
7. `TitleGenerationHook.after_agent()` does a best-effort wait (default 3 s,
   configurable — see below) so `title_update` arrives before the `done` event.
8. The client receives the event, updates the session title in the TanStack
   Query cache in-place (no re-fetch), and animates the title in the sidebar.

Failures at any step are caught and logged — the raw-truncation fallback title
remains. The agent run is never blocked by the LLM call itself.

---

## Configuration — `.openagentd/config/title_generation.md`

All tunables live in a single file. YAML frontmatter for settings, Markdown
body for the system prompt.

```markdown
---
enabled: true
model: googlegenai:gemini-3.1-flash-lite-preview
wait_timeout_seconds: 3.0
---

You are a title generator. You output ONLY a conversation title. Nothing else.

## Task
...rest of the prompt...
```

### Fields

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `true` | Feature switch. `false` disables title generation with a warning at startup. |
| `model` | agent's own model | `provider:model` string for a dedicated (cheap) title LLM. |
| `wait_timeout_seconds` | `3.0` | Best-effort cap (seconds) on how long `after_agent` waits for the background title task before the agent loop completes. Set to `0` for fully non-blocking mode — the title still lands via SSE whenever it's ready. |

### Graceful degradation

Title generation is **soft-required**: if any of the following is true,
`build_title_generation_hook` returns `None` with a `logger.warning` and new
sessions simply keep their raw-truncation fallback title — no exception:

- The config file does not exist.
- `enabled: false` in the frontmatter.
- The file body (prompt) is empty.

This means deleting the file disables the feature cleanly; there is no
bundled default prompt.

Path and module defaults live in `app/agent/hooks/title_generation.py`
(`title_generation_config_path()`, `DEFAULT_WAIT_TIMEOUT_SECONDS`).

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

### Scheduled-task sessions are skipped

Sessions created by the scheduler carry a `[Scheduled Task: <name>]` prefix
in the user message (injected by `TaskScheduler._fire_task` before calling
`dispatch_user_message`). `before_agent` detects this prefix and returns
early — no title LLM call is made and no `title_update` SSE event is emitted.

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

```python
provider.chat(
    messages=[
        SystemMessage(content=system_prompt),   # from config file body
        HumanMessage(content=user_text),        # capped at 500 chars
    ],
    max_tokens=20,
    temperature=0.2,
    thinking_level="none",
)
```

`max_tokens=20` is sufficient — the ≤50 character output cap is at most
~12–13 tokens. `thinking_level="none"` explicitly disables extended thinking
on providers that support it (e.g. ZAI, Gemini), overriding any
`thinking_level` set in the agent's `model_kwargs` — no reasoning tokens are
spent on a title.

Timeout: 15 seconds (inside `title_service`, separate from the hook wait).
On timeout or any exception, logs at `warning` and returns — fallback title
stays.

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
- Correct LLM parameters (`max_tokens=20`, `temperature=0.2`, `thinking_level="none"`)
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

- User-editable titles via `PATCH /chat/sessions/{id}` (DB field already exists)
- Re-generation trigger for sessions that significantly change topic after turn 1
