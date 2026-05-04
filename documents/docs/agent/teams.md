---
title: Multi-Agent Teams
description: Team architecture, activation loop, mailbox coordination, and member protocols.
status: stable
updated: 2026-05-04
---

# Agent Teams

**Source:** `app/agent/mode/team/`

Multi-agent teams coordinate a lead agent with N specialized member agents. The lead plans, delegates, and synthesizes. Members work independently on assigned tasks and report back.

---

## Architecture overview

```
AgentTeam
├── name: str                ← team identity
├── lead: TeamLead           ← receives user messages, plans, delegates
├── members: {name: TeamMember, ...}   ← specialized workers
└── mailbox: TeamMailbox     ← per-agent asyncio.Queue inboxes

TeamMemberBase (ABC)          ← shared worker infrastructure
├── TeamLead                 ← no safety-net, skips user-only inbox persistence
└── TeamMember               ← safety-net auto-reply, error notification to lead
```

`TeamLead` and `TeamMember` both extend `TeamMemberBase`, which wraps an `Agent`. Agents are activated on-demand via `_run_activation()` when messages arrive in their mailbox. Each role overrides template methods for role-specific behavior.

All streaming goes to a **single in-memory stream key** (the lead's `session_id`), tagged by `agent` field. The frontend subscribes once and receives a unified event feed.

---

## Configuration

Each agent is a `.md` file in `OPENAGENTD_CONFIG_DIR/agents/`. Exactly one must have `role: lead`.

```markdown
---
name: orchestrator
role: lead
model: zai:glm-5v-turbo   # multimodal recommended — lead handles user input
tools: [read, ls]
---

You are the orchestrator. Break down tasks, delegate to members, synthesize results.
```

```markdown
---
name: explorer
role: member
model: zai:glm-5-turbo
tools: [web_search, web_fetch, glob, grep]
---

You are an explorer. Find information, summarize findings.
```

`team_message` is injected automatically into every agent — do not list it in `tools:`.

---

## Lifecycle

### Startup

```python
team = AgentTeam(name="task-force", lead=lead_member, members={...})
await team.start()
# → each member: _ensure_db_session(), mailbox.register(name)
# → install on_message callback for mailbox
```

### Handling a user message

```python
session_id = await team.handle_user_message(content="Research X", session_id=new_uuid)
# client subscribes to GET /api/team/stream/{session_id}
```

Inside `handle_user_message`:
1. Update lead's `session_id` + ensure DB session row exists.
2. **Restore or rotate member sessions** — queries `ChatSession` rows matching `parent_session_id = lead_uuid` and `agent_name`. Only sessions belonging to the same team and lead are reused.
3. Save `HumanMessage` to lead's DB session.
4. Link all member sessions to lead via `parent_session_id` FK.
5. `stream_store.init_turn(session_id)` — synchronously, before delivering message (no race condition).
6. Set `_has_active_turn = True`.
7. Put `Message(from_agent="user", content="[user]: {content}")` in lead's mailbox.

### Activation

On each message arrival, `_maybe_activate()` spawns a one-shot `_run_activation()` task:

```
message arrives in mailbox
│
└─ on_message callback fires (from mailbox.send/broadcast)
   │
   └─ _maybe_activate()
      ├─ if state == "working" → message is already in queue; TeamInboxHook
      │  will drain it before the next LLM call → return
      └─ else:
           state = "working"    ← set synchronously before create_task so that
           │                       _try_emit_done() never sees a stale "available"
           └─ _active_task = create_task(_run_activation())

_run_activation() ← one-shot task
│
├─ _cancel_event.clear()
│
├─ drain all queued messages (receive_nowait loop)
│   └─ if inbox empty → state = "available"; return  ← spurious wakeup, no agent.run()
│
├─ emit agent_status working
│
├─ await _handle_messages(pending_messages)
│    ├─ load DB history (get_messages_for_llm)
│    ├─ format inbox messages as HumanMessages with [sender]: prefix
│    ├─ run_messages = history + inbox_as_chat
                │    ├─ build hooks: [AgentTeamProtocolHook, TeamInboxHook, StreamPublisherHook, (TitleGenerationHook — lead only), SummarizationHook]
│    │     TeamInboxHook.before_model(): drains mailbox between agent loop iterations,
│    │     persists new messages, emits inbox SSE, appends to state.messages, and
│    │     returns an updated ModelRequest so the current LLM call sees messages
│    │     that arrived while tools were executing.
│    ├─ get injected team tools
│    ├─ set_sandbox(workspace_dir(lead_session_id))
│    └─ await agent.run(run_messages, hooks=hooks, injected_tools=injected)
│
├─ _on_turn_success()
│    └─ TeamMember only: safety net — if not _replied → send "[done — no explicit reply]" to lead
├─ (on error) _on_turn_error()
│    ├─ TeamMember: notify lead via mailbox ("[name]: System error — temporarily unavailable…")
│    └─ TeamLead: push typed ErrorEvent to stream (SSE `error` event) so UI surfaces the failure
│
└─ finally:
    _on_turn_finally()       ← TeamMember: clear _current_task_id
    state = "available"
    emit agent_status available

    ── late-inbox check ──────────────────────────────────────────────────
    │  A message can arrive in the mailbox while agent.run() is executing
    │  its last LLM call (e.g. a peer replies while streaming <sleep>).
    │  TeamInboxHook never fires again after agent.run() breaks, so the
    │  message would be lost without this check.
    │
    if inbox not empty:
        _maybe_activate()   ← sets state="working" synchronously, spawns new task
                               _try_emit_done() below sees "working" → will not fire done
    ── end late-inbox check ──────────────────────────────────────────────

    team._try_emit_done()   ← emits "done" only if ALL agents are "available"
```

### Shutdown

```python
await team.stop()
# → cancels all active _active_task tasks (5s timeout)
# → deregisters agents from mailbox
```

### Live config — drift detection (no team reload)

**Files:** `app/agent/drift.py` (`ConfigStamp`, `stamp_agent_files`, `detect_drift` — leaf module imported by both sides), `app/agent/loader.py`, `app/agent/mode/team/member.py`

CRUD routes (`/api/agents`, `/api/skills`, `/api/mcp/*`) write to disk
and **do not** restart the team. Each member stamps the mtimes of its
own `.md`, `mcp.json`, and every referenced `SKILL.md` in
`agent.config_stamp` at build time. At end-of-turn the wrapper detects
drift; on the next `_run_activation()` it re-parses the `.md` and swaps
`self.agent` in place (model, tools, prompt, MCP). The `TeamMember`
wrapper, mailbox binding, and `session_id` are preserved. Parse failures
keep the previous agent and re-stamp to avoid looping.

External callers that need fresh frontmatter without waiting for the
next turn (e.g. `GET /team/agents`) call the public
`TeamMemberBase.refresh_if_dirty()` — `team_manager.refresh_idle_agents()`
loops over idle members and applies it. Working members are skipped to
avoid racing `agent.run()`. See
`app/agent/mode/team/member.py:refresh_if_dirty` and
`app/services/team_manager.py:refresh_idle_agents`.

Adding/removing **agent files** at runtime (team-shape change) is out
of scope — drift detection assumes the roster is fixed for the
process.

### `team_manager` — lifecycle + admin reload

**File:** `app/services/team_manager.py`

`team_manager` is the module-level wrapper around the running
`AgentTeam`. Production routes only call `start()` / `stop()` (lifespan)
and `invalidate_skill_cache()` (clears the `discover_skills` `lru_cache`
after a skill write). `reload()` is retained as an admin/test escape
hatch — it stops the team, rebuilds from disk via `load_team_from_dir`,
and returns a `TeamDiff`. It is **not** called on file writes today;
drift detection covers that path.

```python
await team_manager.start()              # lifespan startup
team_manager.invalidate_skill_cache()   # after a skill write
diff = await team_manager.reload()      # admin/test only
await team_manager.stop()               # lifespan shutdown
```

Serial execution is enforced via `asyncio.Lock` — concurrent calls
cannot race on `set_team()`. The lock is also taken by `start()` and
`stop()`.

---

## Mailbox

**File:** `mailbox.py`

Per-agent `asyncio.Queue` inboxes. Accepts an optional `on_message` callback that fires after every `send()` or `broadcast()` to trigger agent activation.

```python
async def on_message_callback(agent_name: str) -> None:
    """Fire activation for this agent."""

mailbox = TeamMailbox(on_message=on_message_callback)
mailbox.register("explorer")   # create inbox (idempotent)

# Point-to-point
await mailbox.send(to="explorer", message=Message(from_agent="lead", content="..."))
# → fires on_message("explorer") before returning

# Broadcast — delivers to all inboxes except sender's
await mailbox.broadcast(Message(from_agent="lead", content="[broadcast]: ..."))
# → fires on_message(agent_name) for each recipient before returning

# Receive (blocking)
msg = await mailbox.receive("explorer")
```

| Method | Notes |
|--------|-------|
| `register(name)` | Create inbox (idempotent). |
| `deregister(name)` | Remove inbox; undelivered messages discarded. |
| `send(to, message)` | Single delivery. Raises `KeyError` if not registered. Fires `on_message` callback. |
| `broadcast(message)` | Copies to all except sender. Marks `is_broadcast=True`. Fires `on_message` per recipient. |
| `receive(name)` | Async, blocks until message. |
| `receive_nowait(name)` | Sync, raises `asyncio.QueueEmpty` if empty. |
| `inbox_empty(name)` | Non-blocking check. |

Message fields: `id`, `from_agent`, `to_agent` (None = broadcast), `content`, `is_broadcast`, `timestamp`.

---

## Team communication tools

**File:** `app/agent/mode/team/tools.py`

Injected automatically — do not list in `tools:`.

Everyone gets `team_message`.

| Factory | Returns | For |
|---------|---------|-----|
| `make_team_message_tool(mailbox, agent_name, role)` | `[team_message]` | All team agents (lead + members) |

### `team_message` tool

```
team_message(to: list[str], content: str) -> str
```

- `to`: list of exact recipient names from the team roster
- `content`: work output only — findings, drafts, data, task instructions, or questions
- Self-messaging is silently dropped (agent cannot message itself)
- Recipients are validated against `mailbox.registered_agents` — unknown names return an error string listing available agents
- The sender prefix `[agent_name]: ` is added automatically — agents must not include it in `content`

The tool description is **role-specific** via the `role` parameter (`"lead"` or `"member"`):
- **Lead**: "delegate tasks, provide instructions, relay scope changes, ask for status"
- **Member**: "Your ONLY way to communicate. Call this tool to: deliver work output, hand off results to a peer, ask unblocking questions"

Tool-mechanical rules (one call per audience, no name prefix, content constraints) are self-contained in the Field descriptions — not repeated in protocol constants. Member protocol also says not to use plain text output; completed work must be delivered through `team_message`.

---

## SSE events (team-specific)

All events carry an `agent` field to identify the source.

| Event | Who emits | Payload |
|-------|-----------|---------|
| `agent_status` | `AgentTeam._emit()` | `{agent, status: "working"\|"available"\|"error"}` |
| `inbox` | `TeamInboxHook.before_model()` + `_run_activation()` | `{agent, content, from_agent}` |
| `error` | `TeamLead._on_turn_error()` | `{message, metadata: {agent, exception}}` — emitted only when the **lead** fails; member failures route through the mailbox instead |
| `done` | `AgentTeam._try_emit_done()` | `{}` |
| `message`, `thinking`, `tool_call`, `tool_start`, `tool_end`, `usage` | `StreamPublisherHook` | Same as single-agent, plus `agent` field |

> **Note:** `agent_done` was removed. `agent_status: available` is the sole signal that an individual agent has finished its turn. The frontend uses `agent_status` for per-agent indicators and `done` for the team-wide "all idle" state.
>
> `agent_status` is stored as a latest-wins `{agent: status}` map in the stream state blob and replayed on reconnect **before** any thinking/message events. This ensures a client that refreshes mid-turn sees per-agent working indicators light up before text tokens arrive. `thinking` and `message` replay is also per-agent — see [`architecture.md`](../architecture.md) for the state schema.

### `_try_emit_done` logic

```python
if self._has_active_turn and lead.state == "available" and all(m.state == "available" for m in members):
    _has_active_turn = False
    push_event(session_id, done_event)
    mark_done(session_id)
```

Called from every agent's `_run_activation` finally block — fires at most once per turn.

---

## Database layout

| Table | What's stored |
|-------|-------------|
| `chat_sessions` (lead, top-level) | `parent_session_id IS NULL` — the lead row for a team session |
| `chat_sessions` (member, child) | `parent_session_id=lead_uuid` — one per active team member |
| `session_messages` | Each agent's messages in its own session |

There is no longer a ``session_type`` column. Top-level sessions (team leads, scheduled-task sessions) are identified by `parent_session_id IS NULL`; team-member sessions are children of their lead via the FK.

`GET /api/team/{session_id}/history` queries sub-sessions by `parent_session_id` — not live team state. Works correctly for historical sessions, including orphaned members.

---

## Sandbox scoping

Team members share a workspace rooted at `{OPENAGENTD_WORKSPACE_DIR}/{lead_session_id}/` — resolved through `app.core.paths.workspace_dir(lead_session_id)`. All members of a team write into this single root so they can collaborate on shared files. The sandbox itself uses a denylist (see [`tools.md`](tools.md#filesystem-builtinfilesystem)).

```python
from app.core.paths import workspace_dir

workspace = str(workspace_dir(lead_session_id))
token = set_sandbox(SandboxConfig(workspace=workspace))
try:
    await agent.run(...)
finally:
    _sandbox_ctx.reset(token)
```

---

## Interrupt flow

### Via HTTP (`POST /api/team/chat`)

`POST /api/team/chat` uses the same `ChatForm` model as single-agent chat. When `interrupt=true`:

```
POST /api/team/chat  interrupt=true  session_id=<lead_sid>
│
├─ route handler calls team.handle_user_message(..., interrupt=True)
└─ returns {"status": "interrupted", "session_id": "..."}
```

### Inside `handle_user_message`

```
team.handle_user_message(content="...", session_id=sid, interrupt=True)
│
├─ find all members with state == "working"
├─ member._cancel_event.set()   ← agent loop breaks mid-stream or cancels tools
├─ board.reset_for_interrupt()  ← non-completed tasks → pending
└─ deliver new message to lead inbox
```

The `_cancel_event` is cleared at the top of each `_worker_loop` iteration — a stale cancel doesn't abort the next run.

### What happens to in-flight tool calls

When `_cancel_event` fires during a member's tool execution, `_gather_or_cancel()` in the agent loop handles it:

- **Tools that already completed** keep their real results — no data is lost.
- **Tools still running** are cancelled via `asyncio.Task.cancel()` and produce `ToolMessage(content="Cancelled by user.")`.
- The loop breaks after appending all tool results — no further LLM iterations.
- After `agent.run()` returns, the member appends `[interrupted]` to the last assistant message in DB.

---

## System prompt protocol hook

**File:** `app/agent/mode/team/hooks/team_prompt.py` — `AgentTeamProtocolHook`

Injected in `TeamMemberBase._handle_messages()` before every `agent.run()`. The hook resolves the `TeamMemberBase` instance and calls `member.build_protocol(base_prompt, team)` — each role class assembles its own protocol. No role branching in the hook.

Protocol constants (`COMMUNICATION_RULES`, `MESSAGE_FORMAT`, `LEAD_PROTOCOL`, `MEMBER_PROTOCOL`) live in `app/agent/mode/team/member.py`. Member protocol templates use `{lead_name}` placeholders — `build_protocol()` fills them with the actual lead name at runtime, so protocol examples always reference the correct lead regardless of config.

### What each role injects

| Section | `TeamLead.build_protocol()` | `TeamMember.build_protocol()` |
|---------|------|---------|
| Communication rules | plain text is user-visible and reserved for the final answer, plus one optional brief progress note after delegation; coordination via `team_message` tool | `team_message` is the ONLY communication method for results; do not use plain text output; no social messages; collaborate directly with peers via `team_message`; respond exactly `<sleep>` with no tool calls when idle |
| Message format | `[name]: content`, `[user]: content` | `[{lead_name}]: content` (lead), `[name]: content` (peers) |
| Workflow | receive → delegate → wait (or `<sleep>`) → synthesise | receive → work → `team_message` peers for help if needed → `team_message` results to lead or next peer → `<sleep>` |
| Team roster | all members with descriptions | lead `[lead]` + other members (not self) |

Tool-mechanical rules (one call per audience, no name prefix in content, work-output-only content) are in the `team_message` tool description itself — not in the protocol constants. The tool description is role-specific: lead gets delegation-focused wording, members get delivery-focused wording.

### Usage

```python
from app.agent.mode.team.hooks.team_prompt import AgentTeamProtocolHook

hook = AgentTeamProtocolHook(team=team, agent_name="explorer")
await agent.run(messages, hooks=[hook, publisher_hook, ...])
```

---

## Provider-specific pitfalls

### Gemini: Role alternation violations

Team message history can violate Gemini's strict `user → model → user` alternation:

- **Synthetic `[DONE]` messages**: `message_leader(stop=true)` appends `AssistantMessage(content="[DONE]")`, creating consecutive model turns. **Fix**: Filter them out in `_convert_messages_to_gemini()`.
- **Consecutive HumanMessages**: Inbox messages (from lead/teammates) are appended as `HumanMessage`. If DB history ends with a `HumanMessage`, you get consecutive user turns. **Fix**: The same-role merging in the provider handles this.
- **Error**: `"Please ensure that function call turn comes immediately after a user turn or after a function response turn"` — means a `model` message with `functionCall` appeared after another `model` message.

---

## Architecture diagram

```mermaid
graph TB
    User([User]) -->|POST /api/team/chat| Route
    User -->|GET /api/team/{sid}/stream| StreamStore

    subgraph Backend
        Route["API Route\n─────────\nsave user msg to DB\ninit_turn(session_id)\nmailbox.send(lead)\nreturns 202"]

        subgraph AgentTeam["AgentTeam (starts at lifespan)"]
            Lead["Team Lead\n──────────────\nTeamLead(TeamMemberBase)\nStreamPublisherHook\nsend_message · broadcast\ncreate_tasks · assign_task"]

            subgraph Mailbox["TeamMailbox"]
                LI[lead inbox]
                RI[member inboxes]
            end

            subgraph TaskBoard["TeamTaskBoard (shared, asyncio.Lock)"]
                T1["task_1 · pending"]
                T2["task_2 · in_progress"]
            end

            Members["Member agents\n──────────────\nTeamMember(TeamMemberBase) (each)\nStreamPublisherHook\nmessage_leader · claim_task"]
        end

        StreamStore["In-memory stream_store\n─────────────────\nstate:{lead_sid}\nevents:{lead_sid}\nAll agents write here"]
    end

    Route -->|mailbox.send| LI
    Lead -->|send_message / broadcast| RI
    Members -->|message_leader| LI
    Lead <-->|read/write| TaskBoard
    Members <-->|read/write| TaskBoard
    Lead -->|StreamPublisherHook| StreamStore
    Members -->|StreamPublisherHook| StreamStore
    StreamStore -->|SSE| User
```

## Server restart during active work

If the server restarts while team members are actively working, the shutdown and recovery behave as follows.

### Shutdown sequence

The lifespan handler (`app/api/app.py`) calls `AgentTeam.stop()`:
1. Waits up to 5 seconds for each active task to complete or cancels if still running.
2. Deregisters agents from the mailbox.
3. Clears in-memory stream state.

**`mark_done()` is never called during shutdown** — the turn state freezes mid-flight.

### What survives vs. what is lost

| State | Persisted? | Notes |
|-------|-----------|-------|
| User messages & completed turns | Yes (DB) | Safe — fully checkpointed |
| Session records & conversation history | Yes (DB) | Safe — `chat_sessions` + `session_messages` rows intact |
| Mailbox messages (`asyncio.Queue`) | **No** (in-memory) | **Lost** — pending tasks the lead assigned but members haven't processed are gone |
| `_has_active_turn` flag | **No** (in-memory) | **Resets to `False`** on restart; `_try_emit_done()` won't fire for the old turn |
| Active task state (`_active_task`) | **No** (in-memory) | **Lost** — agents are re-created without any active tasks on restart |
| Partial LLM streaming responses | **No** | **Lost** — mid-stream assistant text not yet checkpointed |
| Task board state (`TeamTaskBoard`) | **No** (in-memory) | **Lost** — all task statuses, assignments, dependencies gone |
| `is_streaming` flag (in-memory) | **Stuck as `true`** | Never cleared; frontend may hang waiting for a `done` event that never comes |

### After restart — what the user sees

1. **Session restoration works** — `handle_user_message()` (`team.py`) queries DB for `ChatSession` rows with matching `parent_session_id` and `agent_name` and reuses those session IDs. Conversation history is preserved.

2. **No work resumes** — the team reinitializes with `_has_active_turn = False`, empty mailbox queues, and an empty task board. Nobody remembers what was in-flight. The lead doesn't know it had delegated work. Members don't know they had pending tasks.

3. **Frontend gets stuck** — `is_streaming` from the previous turn was never cleared. The client waits indefinitely for a `done` event. The user must send a new message or reload to recover.

### Recovery path

The user sends a new message → new turn starts → lead sees conversation history from DB → lead can pick up where it left off based on context. This depends entirely on LLM reasoning — there is no programmatic recovery of in-flight work.

### Gaps to address

| Gap | Impact | Potential fix |
|-----|--------|--------------|
| `is_streaming` frozen on restart | Frontend hangs forever | Auto-expire turn state after configurable timeout; or clear stale flags at startup |
| `_has_active_turn` not persisted | `mark_done()` never called for interrupted turn | Store flag in DB; restore on startup |
| Mailbox not persisted | Pending delegated tasks lost | Persist `team_message()` calls to DB; replay on restart |
| Task board not persisted | All task state lost | Persist board to DB; restore on startup |
| Partial assistant messages | Incomplete text in DB | Append `[interrupted — server restart]` marker during shutdown |

---

## Agent flow diagram

```mermaid
graph TD
    START((Start)) --> RECV[Receive User Message]
    RECV --> SAVE_MSG[Save HumanMessage to Lead DB session]
    SAVE_MSG --> INIT[init_turn in stream_store]
    INIT --> DELIVER[Deliver to Lead Mailbox]

    DELIVER --> LEAD_ACTIVATE[Lead: _run_activation spawned]
    LEAD_ACTIVATE --> LEAD_ON_WAKE[Lead: on_wake hook]
    LEAD_ON_WAKE --> LEAD_BEFORE_MODEL[Lead: before_model hooks]

    subgraph lead_before_model [Lead before_model]
        L_BM_SUMMARIZE{Prompt tokens<br/>ge 30k?}
        L_BM_SUMMARIZE -->|Yes| L_SUMMARIZE[Summarize via LLM]
        L_SUMMARIZE --> L_BM_DONE[Continue]
        L_BM_SUMMARIZE -->|No| L_BM_DONE
    end

    LEAD_BEFORE_MODEL --> LEAD_WRAP_MODEL[Lead: wrap_model_call hooks]

    subgraph lead_wrap_model [Lead wrap_model_call]
        L_MEMORY[Memory] --> L_DATE[Inject Date]
        L_DATE --> L_OTEL[OTel span]
    end

    LEAD_WRAP_MODEL --> LEAD_LLM[Lead: Call LLM - stream]

    subgraph lead_streaming [Lead Streaming]
        L_CHUNK{Next chunk?}
        L_CHUNK -->|Yes| L_DELTA[on_model_delta hooks<br/>StreamPublisher - SSE<br/>SessionLog - JSONL]
        L_DELTA --> L_CHUNK
        L_CHUNK -->|No| L_STREAM_END[Stream complete]
    end

    LEAD_LLM --> L_CHUNK
    L_STREAM_END --> LEAD_AFTER_MODEL[Lead: after_model hooks]
    LEAD_AFTER_MODEL --> LEAD_CHECKPOINT[Checkpointer sync]

    LEAD_CHECKPOINT --> LEAD_DECISION{Lead response type?}
    LEAD_DECISION -->|team_message tool| DELEGATE[Delegate tasks to Members]
    LEAD_DECISION -->|other tools| LEAD_TOOL_EXEC[Execute tools]
    LEAD_TOOL_EXEC --> LEAD_BEFORE_MODEL
    LEAD_DECISION -->|final text only| LEAD_FINAL[Lead produces final answer]

    DELEGATE --> LEAD_AVAILABLE[Lead: available]
    DELEGATE --> M1_ACTIVATE[Member A: _run_activation spawned]
    DELEGATE --> M2_ACTIVATE[Member B: _run_activation spawned]

    subgraph member_a [Member A - concurrent]
        M1_ACTIVATE --> M1_WAKE[on_wake hook]
        M1_WAKE --> M1_PERSIST[Persist inbox msg to A session DB]
        M1_PERSIST --> M1_SSE_INBOX[SSE inbox event<br/>agent_status: working]
        M1_SSE_INBOX --> M1_BEFORE_MODEL[before_model hooks<br/>TeamInboxHook drains mailbox]
        M1_BEFORE_MODEL --> M1_WRAP[wrap_model_call<br/>Memory plus Date plus OTel]
        M1_WRAP --> M1_LLM[Call LLM - stream]
        M1_LLM --> M1_DELTA[on_model_delta hooks<br/>StreamPublisher agent=A]
        M1_DELTA --> M1_AFTER[after_model hooks]
        M1_AFTER --> M1_CHECKPOINT_A[Checkpointer sync]
        M1_CHECKPOINT_A --> M1_TOOL_D{Tool calls?}
        M1_TOOL_D -->|Yes| M1_TOOLS[Execute tools]
        M1_TOOLS --> M1_OFFLOAD{Result gt 8k?}
        M1_OFFLOAD -->|Yes| M1_DISK[Offload to disk]
        M1_OFFLOAD -->|No| M1_TOOL_DONE[tool_end SSE]
        M1_DISK --> M1_TOOL_DONE
        M1_TOOL_DONE --> M1_BEFORE_MODEL
        M1_TOOL_D -->|No| M1_REPLY[team_message to Lead mailbox]
        M1_REPLY --> M1_AVAILABLE[available<br/>agent_status: available SSE]
        M1_AVAILABLE --> M1_TRY_DONE[_try_emit_done<br/>not all available yet]
    end

    subgraph member_b [Member B - concurrent]
        M2_ACTIVATE --> M2_WAKE[on_wake hook]
        M2_WAKE --> M2_PERSIST[Persist inbox msg to B session DB]
        M2_PERSIST --> M2_SSE_INBOX[SSE inbox event<br/>agent_status: working]
        M2_SSE_INBOX --> M2_BEFORE_MODEL[before_model hooks<br/>TeamInboxHook drains mailbox]
        M2_BEFORE_MODEL --> M2_WRAP[wrap_model_call<br/>Memory plus Date plus OTel]
        M2_WRAP --> M2_LLM[Call LLM - stream]
        M2_LLM --> M2_DELTA[on_model_delta hooks<br/>StreamPublisher agent=B]
        M2_DELTA --> M2_AFTER[after_model hooks]
        M2_AFTER --> M2_CHECKPOINT_A[Checkpointer sync]
        M2_CHECKPOINT_A --> M2_TOOL_D{Tool calls?}
        M2_TOOL_D -->|Yes| M2_TOOLS[Execute tools]
        M2_TOOLS --> M2_OFFLOAD{Result gt 8k?}
        M2_OFFLOAD -->|Yes| M2_DISK[Offload to disk]
        M2_OFFLOAD -->|No| M2_TOOL_DONE[tool_end SSE]
        M2_DISK --> M2_TOOL_DONE
        M2_TOOL_DONE --> M2_BEFORE_MODEL
        M2_TOOL_D -->|No| M2_REPLY[team_message to Lead mailbox]
        M2_REPLY --> M2_AVAILABLE[available<br/>agent_status: available SSE]
        M2_AVAILABLE --> M2_TRY_DONE[_try_emit_done<br/>not all available yet]
    end

    M1_TRY_DONE --> LEAD_ACTIVATE2[Lead: _run_activation spawned<br/>results from A plus B]
    M2_TRY_DONE --> LEAD_ACTIVATE2

    LEAD_ACTIVATE2 --> LEAD_ON_WAKE2[Lead: on_wake hook]
    LEAD_ON_WAKE2 --> LEAD_INBOX2[TeamInboxHook<br/>drain mailbox - inject results]
    LEAD_INBOX2 --> LEAD_WRAP2[wrap_model_call<br/>Memory plus Date plus OTel]
    LEAD_WRAP2 --> LEAD_LLM2[Lead: Call LLM - synthesize]
    LEAD_LLM2 --> LEAD_DELTA2[on_model_delta hooks<br/>stream final answer]
    LEAD_DELTA2 --> LEAD_AFTER2[after_model hooks]
    LEAD_AFTER2 --> LEAD_CHECKPOINT2[Checkpointer sync]
    LEAD_CHECKPOINT2 --> LEAD_FINAL

    LEAD_FINAL --> LEAD_AVAILABLE2[Lead: available]
    LEAD_AVAILABLE2 --> CHECK{All agents available?<br/>lead plus A plus B}
    CHECK -->|No| LEAD_ACTIVATE2
    CHECK -->|Yes| MARK_DONE[stream_store.mark_done<br/>SSE done event]
    MARK_DONE --> END((End))

    style START fill:#000,color:#fff
    style END fill:#000,color:#fff
    style LEAD_LLM fill:#4A90D9,color:#fff
    style LEAD_LLM2 fill:#4A90D9,color:#fff
    style M1_LLM fill:#6ABF69,color:#fff
    style M2_LLM fill:#6ABF69,color:#fff
    style DELEGATE fill:#E8913A,color:#fff
    style LEAD_DECISION fill:#F5D76E,color:#000
    style M1_TOOL_D fill:#F5D76E,color:#000
    style M2_TOOL_D fill:#F5D76E,color:#000
    style M1_OFFLOAD fill:#F5D76E,color:#000
    style M2_OFFLOAD fill:#F5D76E,color:#000
    style CHECK fill:#F5D76E,color:#000
    style L_BM_SUMMARIZE fill:#F5D76E,color:#000
    style L_MEMORY fill:#9B59B6,color:#fff
    style L_SUMMARIZE fill:#9B59B6,color:#fff
    style M1_SSE_INBOX fill:#9B59B6,color:#fff
    style M2_SSE_INBOX fill:#9B59B6,color:#fff
    style LEAD_INBOX2 fill:#9B59B6,color:#fff
    style LEAD_AVAILABLE fill:#95A5A6,color:#fff
    style M1_AVAILABLE fill:#95A5A6,color:#fff
    style M2_AVAILABLE fill:#95A5A6,color:#fff
    style LEAD_AVAILABLE2 fill:#95A5A6,color:#fff
    style LEAD_CHECKPOINT fill:#95A5A6,color:#fff
    style LEAD_CHECKPOINT2 fill:#95A5A6,color:#fff
    style M1_CHECKPOINT_A fill:#95A5A6,color:#fff
    style M2_CHECKPOINT_A fill:#95A5A6,color:#fff
    style M1_DISK fill:#E67E22,color:#fff
    style M2_DISK fill:#E67E22,color:#fff
```

| Color  | Meaning                                |
| ------ | -------------------------------------- |
| Blue   | Lead LLM call                          |
| Green  | Member LLM call                        |
| Orange | Delegation / offload                   |
| Purple | Prompt mutation — summarization, inbox |
| Gray   | Checkpointer sync / idle               |
| Yellow | Decision node                          |

---

## Deferred / not implemented

- Member hung timeout (configurable `member_timeout` — agents can be stuck in `_run_activation`)
- Multiple teams (one global team per process)
- Nested teams
- Turn state recovery after server restart (see section above)
- Migration tooling for team config changes (currently: breaking change = orphaned sessions)
