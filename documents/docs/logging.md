---
title: Logging Architecture
description: Two-tier loguru system: app-wide JSON logs, per-session transcripts, structured JSONL events with file rotation.
status: stable
updated: 2026-06-28
---

# Logging

**Source:** `app/core/logging_config.py`, `app/agent/hooks/session_log.py`

openagentd uses a two-tier logging system built on [loguru](https://github.com/Delgan/loguru): application-wide logs and per-session logs.

---

## Architecture

### Directory Structure

Log paths live under `{OPENAGENTD_STATE_DIR}/logs/`. Value depends on environment:

| Mode | `OPENAGENTD_STATE_DIR` |
|------|--------------------|
| Production | `~/.local/state/openagentd/` |
| Development | `.openagentd/state/` (project root) |

```
{OPENAGENTD_STATE_DIR}/
└── logs/
    ├── app/
    │   ├── app.log                          # Current JSON log (DEBUG+)
    │   ├── app-error.log                    # Current JSON error log (ERROR+)
    │   └── app.<timestamp>.log              # Rotated app.log segments (10 MB → retention 7 days)
    └── sessions/
        └── {session_id}/
            ├── session.log                  # Human-readable, all DEBUG+ logs
            └── {agent_name}.jsonl           # Structured events (SessionLogHook) — one per agent
```

In team mode there is one `{agent_name}.jsonl` per active agent (e.g. `openagentd.jsonl`, `explorer.jsonl`, `writer.jsonl`); single-agent chat produces one named after the lead agent.

Session workspaces (`workspace_dir(sid)`) — and the user-upload subdir
inside them (`uploads_dir(sid) == workspace_dir(sid)/uploads`) — live
under `OPENAGENTD_WORKSPACE_DIR`, not `OPENAGENTD_STATE_DIR`. See
[`configuration.md`](configuration.md#sandbox).

### Log Tier Comparison

| Aspect | Application Log | Session Logs |
|--------|-----------------|--------------|
| **Location** | `{OPENAGENTD_STATE_DIR}/logs/app/app.log` + `app-error.log` | `{OPENAGENTD_STATE_DIR}/logs/sessions/{id}/` |
| **Format (app)** | JSON | Plain text (human-readable) |
| **Format (events)** | — | JSONL (structured events) |
| **Level** | `app.log`: DEBUG+, `app-error.log`: ERROR+ | DEBUG+ (both) |
| **Rotation** | `app.log`: 10 MB / 7 days, `app-error.log`: 10 MB / 14 days | 5 MB / 3-day retention (session.log) |
| **Scope** | All modules, all sessions | Single session only |
| **Use Case** | Production debugging, audit trail | Session replay, agent transparency |

---

## Configuration

### Environment Variable

```bash
# .env or environment
LOG_LEVEL=DEBUG      # Maximum verbosity
LOG_LEVEL=INFO       # Default — agent lifecycle only
LOG_LEVEL=WARNING    # Quiet — warnings + errors only
LOG_LEVEL=ERROR      # Silent except errors
```

**Default:** `INFO` (see `app/core/config.py`). Set to `DEBUG` for maximum verbosity in development.

**Applied to:** Console output and per-session `session.log` files. Application JSON log always captures DEBUG+.

### Programmatic Setup

```python
from app.core.logging_config import setup_logging

# Call once at application startup
setup_logging(log_level="INFO")  # or os.getenv("LOG_LEVEL", "DEBUG")
```

**Location:** `app/core/logging_config.py:51`

---

## Application Logs

### File Paths
```
{OPENAGENTD_STATE_DIR}/logs/app/app.log
{OPENAGENTD_STATE_DIR}/logs/app/app-error.log
```

### Format
JSON (loguru's `serialize=True` setting). Each line is a complete JSON object with the log record metadata. `app.log` captures all application logs at DEBUG+, while `app-error.log` is a smaller error-only stream for postmortems and support triage.

### Sample Entry
```json
{
  "text": "2026-04-09 13:29:42.991 | DEBUG    | app.agent.checkpointer:sync:317 - checkpointer_saved_assistant session_id=019d70e0-fefb-72d7-adeb-491f45b74d50 db_id=019d70ee-abc8-749f-a150-19ec95aa162e is_summary=False exclude=False\n",
  "record": {
    "elapsed": { "repr": "0:15:03.498699", "seconds": 903.498699 },
    "exception": null,
    "extra": {},
    "file": { "name": "checkpointer.py", "path": "/Users/.../checkpointer.py" },
    "function": "sync",
    "level": { "icon": "🐞", "name": "DEBUG", "no": 10 },
    "line": 317,
    "message": "checkpointer_saved_assistant session_id=019d70e0-fefb-72d7-adeb-491f45b74d50 ...",
    "module": "checkpointer",
    "name": "app.agent.checkpointer",
    "process": { "id": 9028, "name": "MainProcess" },
    "thread": { "id": 8364677312, "name": "MainThread" },
    "time": { "repr": "2026-04-09 13:29:42.991329+07:00", "timestamp": 1775716182.991329 }
  }
}
```

### Querying

Parse with `json.loads()` per line:

```python
import json

with open("{OPENAGENTD_STATE_DIR}/logs/app/app.log") as f:
    for line in f:
        record = json.loads(line)
        msg = record["message"]
        level = record["record"]["level"]["name"]
        module = record["record"]["name"]
```

---

## Per-Session Logs

Created dynamically when a chat request arrives. Location: `{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/`

### 1. session.log — Human-Readable Transcript

**Format:** Plain text, one log line per event
**Level:** DEBUG+
**Content:** All logs from all modules during the session
**Rotation:** 5 MB, 3-day retention
**Filter:** Only logs containing the `session_id` in their message

**Sample:**
```
2026-04-09 11:23:53.536 | INFO     | app.agent.mode.chat.runner:_run_agent:184 | chat_run_start session_id=019d707b-79ac-735c-894e-001713d09648
2026-04-09 11:23:53.536 | INFO     | app.agent.agent_loop:run:188 | agent_run_start agent=assistant message_count=1 tools=13 session=019d707b-79ac-735c-894e-001713d09648
2026-04-09 11:23:55.430 | DEBUG    | app.agent.agent_loop:_stream_and_assemble:419 | ... (streaming events)
2026-04-09 11:23:56.012 | INFO     | app.agent.agent_loop:run:262 | llm_response agent=assistant iteration=1 elapsed=2.33s content_len=1 reasoning_len=87 tool_calls=0 tokens=2450/1/2451
```

**Implementation:**
- Added via `add_session_sink(session_id)` in team member activation
- Removed via `remove_session_sink(session_id)` in team member cleanup
- Filter function matches `session_id` in log message (line 97-98 in `logging_config.py`)

### 2. {agent_name}.jsonl — Structured Event Log

One JSONL file per agent in the session (e.g., `assistant.jsonl`, `explorer.jsonl`).

**Format:** JSONL (one JSON object per line)
**Level:** DEBUG+ (in practice, only key events)
**Content:** Structured agent lifecycle events
**Rotation:** None (appended throughout session, cleaned on completion)

See [JSONL Event Schema](#jsonl-event-schema) below.

---

## Agent Loop Events

The agent's main loop (`app/agent/agent_loop/`) logs at key points.

### Event Catalog

Line numbers drift; the canonical reference is the `logger.info("event_name …")` call in the linked module. Use ripgrep to jump straight there.

| Event | Level | Fields | Purpose |
|-------|-------|--------|---------|
| `agent_run_start` | INFO | `agent`, `message_count`, `tools`, `session` | Beginning of agent run |
| `agent_iteration` | INFO | `agent`, `iteration`, `max_iterations`, `messages` | Per-loop iteration start |
| `llm_response` | INFO | `agent`, `iteration`, `elapsed`, `content_len`, `reasoning_len`, `tool_calls`, `tokens` (prompt/completion/total) | LLM call succeeded |
| `llm_usage_detail` | DEBUG | `cached_tokens`, `thoughts_tokens`, `tool_use_tokens` | Advanced token breakdown |
| `tool_dispatch` | INFO | `agent`, `count`, tool names | Before executing tool calls |
| `tool_dispatch_skipped_interrupt` | INFO | `agent`, `count` | Interrupt was set before tools dispatched |
| `tool_start` | INFO | `agent`, `tool`, `id`, args preview | Before tool execution |
| `tool_args_parse_failed` | WARNING | `tool`, `raw_args`, `error` | Tool args couldn't be JSON-parsed |
| `tool_done` | INFO | `agent`, `tool`, `elapsed`, `result_len` | After successful tool execution |
| `tool_result_preview` | DEBUG | `agent`, `tool`, `result` (first ~1000 chars) | Tool output snippet |
| `tool_cancelled` | INFO | `agent`, `tool` | Tool cancelled mid-execution by interrupt |
| `tool_cancellation_timeout` | WARNING | `agent`, `pending_tools` | One or more tools did not stop within the bounded cancellation wait |
| `tool_cancellation_pending` | WARNING | `agent`, `tool` | A cancellation-resistant tool remains owned and is still stopping |
| `team_interrupt_user_shells` | INFO | `session_id`, `cancelled` | Direct `!command` tasks cancelled and awaited for an interrupted session |
| `team_interrupt_background_shells` | INFO | `session_id`, `stopped` | Session-owned background shell process groups stopped during interrupt |
| `team_interrupt_background_shells_failed` | WARNING | `session_id`, `error` | Session background cleanup task failed; member/tool cancellation still proceeds |
| `background_shell_session_stop_failed` | WARNING | `pid`, `session_id`, `error` | One background process group resisted session cleanup; remaining matching processes are still attempted |
| `tool_error` | ERROR | `agent`, `tool`, `elapsed`, `error` | Tool execution failed |
| `tool_call_index_collision` | WARNING | `idx`, `existing_id`, `new_id` | Multiple tool calls collided on the same `.index` |
| `tool_call_orphans_healed` | WARNING | `session_id`, `count`, `ids` | Synthetic tool replies inserted on crash recovery |
| `deserialize_drop_partial_tool_call` | WARNING | `tool`, `id`, `args_prefix` | Dropped a tool call whose arguments were truncated by a mid-stream interrupt |
| `llm_provider_error` | ERROR | `model`, `status`, `body` | Non-retryable HTTP error (4xx except 429) |
| `llm_provider_retry` | WARNING | `model`, `status`, `attempt`, `delay`, `retry_after` | Retrying transient error (429, 5xx, connection) |
| `llm_provider_rate_limit_too_long` | WARNING | `model`, `status`, `attempt`, `delay`, `retry_after` | 429 retry delay reached 60s; skipping remaining retries for this provider |
| `llm_provider_exhausted` | WARNING | `model`, `status` or `error`, `attempts` | All retry attempts exhausted for this provider |
| `agent_run_done` | INFO | `agent`, `elapsed`, `iterations`, `total_messages`, `total_tokens` | Final result before returning |
| `checkpointer_sync_failed` | ERROR | `session_id`, `error` | DB persistence failed |

### Log Message Examples

```
agent_run_start agent=assistant message_count=5 tools=12 session=abc-123
agent_iteration agent=assistant iteration=1/100 messages=5
llm_response agent=assistant iteration=1 elapsed=2.33s content_len=142 reasoning_len=0 tool_calls=1 tokens=2450/145/2595
tool_dispatch agent=assistant count=1 tools=[web_search]
tool_start agent=assistant tool=web_search id=call_abc123 args={"query": "weather today..."}
tool_done agent=assistant tool=web_search elapsed=1.43s result_len=4521
agent_run_done agent=assistant elapsed=5.67s iterations=3 total_messages=9 total_tokens=8234 has_response=True
```

---

## Session Sink Lifecycle

### When Sinks Are Created

1. **HTTP POST /api/team/chat** arrives with user message
2. Team member activation begins
   - `add_session_sink(session_id)` creates `{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/` directory, registers loguru sink
   - `stream_store.init_turn()` initialises the in-memory state blob
3. Agent activation task spawned via `_run_activation()`

### When Sinks Are Removed

1. Agent run completes (success or error)
2. Finally block in `_run_activation()` executes
3. `remove_session_sink(session_id)` called
   - Unregisters loguru sink by ID
   - No longer captures logs for this session

### API

```python
from app.core.logging_config import add_session_sink, remove_session_sink

# In request handler:
sink_id = add_session_sink(session_id)  # Returns loguru sink ID
try:
    # ... run agent ...
finally:
    remove_session_sink(session_id)  # Cleanup
```

**Source:** `app/core/logging_config.py:86–122`

---

## JSONL Event Schema

Written by `SessionLogHook` (`app/agent/hooks/session_log.py`). One line = one event.

### Base Fields (All Events)

```json
{
  "ts": "2026-04-09T04:23:53.536+00:00",       // UTC ISO format (ms precision)
  "session": "019d707b-79ac-735c-894e-001713d09648",  // session_id
  "agent": "assistant",                        // agent name
  "event": "agent_start"                       // event type
}
```

### Event Types & Fields

#### `agent_start` — Run begins

```json
{
  "ts": "2026-04-09T04:23:53.536+00:00",
  "session": "...",
  "agent": "assistant",
  "event": "agent_start",
  "trigger": "What is 3+3?",                   // Last HumanMessage content
  "context_messages": 1,                       // Total messages in state
  "role_distribution": {"user": 1},            // Count of each role
  "tools": ["read", "web_search", ...]   // Available tools
}
```

**When:** `before_agent()` hook (line 116 in `session_log.py`)

#### `model_call` — Before LLM invocation

```json
{
  "ts": "...",
  "session": "...",
  "agent": "...",
  "event": "model_call",
  "iteration": 1,                              // Loop iteration number
  "context_messages": 1,                       // Messages sent to LLM
  "role_distribution": {"user": 1}             // Role breakdown
}
```

**When:** `before_model()` hook (line 154 in `session_log.py`)

#### `usage` — Token accounting (streamed)

Emitted multiple times during streaming as token counts update:

```json
{
  "ts": "2026-04-09T04:23:55.430+00:00",
  "session": "...",
  "agent": "...",
  "event": "usage",
  "prompt_tokens": 2450,                       // Input tokens
  "completion_tokens": 0,                      // Output tokens (incremental)
  "total_tokens": 2464,                        // Sum
  "cached_tokens": 1994,                       // (optional) KV cache hits
  "thoughts_tokens": 14,                       // (optional) Extended thinking
  "tool_use_tokens": 5,                        // (optional) Tool tokens
  "model": "gemma-4-31b-it"                    // Model identifier
}
```

**When:** `on_model_delta()` hook when chunk has usage (line 187 in `session_log.py`)

#### `assistant_message` — LLM response received

```json
{
  "ts": "2026-04-09T04:23:56.012+00:00",
  "session": "...",
  "agent": "...",
  "event": "assistant_message",
  "content": "6",                               // Full response (not truncated)
  "reasoning": "The user is asking for...",   // Thinking content (max 2000 chars)
  "has_tool_calls": false,                    // Boolean
  "tool_call_count": 0,                       // Number of tool calls
  "tool_names": [],                           // Names of tools to be called
  "duration_ms": 2330.4                       // Model response duration
}
```

**When:** `after_model()` hook (line 175 in `session_log.py`)

#### `tool_call` — Tool dispatched (not shown in example, but implemented)

Logged for each tool call in the response:

```json
{
  "ts": "...",
  "session": "...",
  "agent": "...",
  "event": "tool_call",
  "name": "web_search",                       // Tool name
  "arguments": "{...}",                       // Raw arguments
  "tool_call_id": "call_abc123",              // LLM's call ID
  "duration_ms": 456.0                        // Execution duration
}
```

#### `tool_result` — Tool execution result

```json
{
  "ts": "...",
  "session": "...",
  "agent": "...",
  "event": "tool_result",
  "name": "web_search",                       // Tool name
  "result": "...",                            // Output (max 5000 chars, truncated with "…[+N]")
  "tool_call_id": "call_abc123",              // Matching call ID
  "duration_ms": 456.0                        // Execution duration
}
```

#### `agent_done` — Run completes

```json
{
  "ts": "2026-04-09T04:23:56.020+00:00",
  "session": "...",
  "agent": "...",
  "event": "agent_done",
  "content": "6",                              // Final response content
  "elapsed_seconds": 2.484,                  // Total time (wall clock)
  "iterations": 1,                           // Number of loops
  "total_tokens": 2483                       // Cumulative tokens used
}
```

**When:** `after_agent()` hook (line 142 in `session_log.py`)

---

## File Rotation & Retention

### Application Log (`{OPENAGENTD_STATE_DIR}/logs/app/app.log`)

- **Rotation Trigger:** 10 MB
- **Retention Policy:** 7 days
- **Pattern:** `app.log`, `app.2026-04-08_16-32-51_305973.log`
- **Encoding:** UTF-8

**Configuration:** `app/core/logging_config.py:72–79`

```python
logger.add(
    APP_LOG_DIR / "app.log",
    level="DEBUG",
    serialize=True,
    rotation="10 MB",
    retention="7 days",
    encoding="utf-8",
)
```

### Session Logs (`{OPENAGENTD_STATE_DIR}/logs/sessions/{id}/session.log`)

- **Rotation Trigger:** 5 MB
- **Retention Policy:** 3 days
- **Encoding:** UTF-8
- **Format:** Human-readable (not JSON)

**Configuration:** `app/core/logging_config.py:100–113`

```python
sink_id = logger.add(
    log_dir / "session.log",
    level="DEBUG",
    format=(
        "{time:YYYY-MM-DD HH:mm:ss.SSS} | "
        "{level:<8} | "
        "{name}:{function}:{line} | "
        "{message}"
    ),
    filter=_session_filter,  # Only logs with session_id in message
    rotation="5 MB",
    retention="3 days",
    encoding="utf-8",
)
```

### JSONL Files (`{OPENAGENTD_STATE_DIR}/logs/sessions/{id}/{agent}.jsonl`)

- **Rotation:** None (appended throughout session)
- **Cleanup:** Manual (no auto-purge)
- **Size:** Typically small (~10 KB per session)

---

## Third-Party Library Silencing

Noisy third-party stdlib loggers are muted at WARN level:

| Logger | Rationale |
|--------|-----------|
| `httpx` | HTTP client debugging noise |
| `httpcore` | HTTP connection pool noise |
| `google.genai` | Google API chatty logs |
| `uvicorn.access` | HTTP request access logs |

**Configuration:** `app/core/logging_config.py:81–83`

```python
for noisy in ("httpx", "httpcore", "google.genai", "uvicorn.access"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
```

---

## Usage Examples

### 1. Reading Application Logs

```python
import json
from pathlib import Path

log_file = Path("{OPENAGENTD_STATE_DIR}/logs/app/app.log")

# Parse JSON lines
for line in log_file.read_text().splitlines():
    if not line.strip():
        continue
    record = json.loads(line)
    msg = record["message"]
    level = record["record"]["level"]["name"]
    module = record["record"]["name"]
    print(f"[{level}] {module}: {msg}")
```

### 2. Querying Session Events

```python
import json
from pathlib import Path

session_id = "019d707b-79ac-735c-894e-001713d09648"
event_log = Path(f"{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/assistant.jsonl")

# Find all tool calls
for line in event_log.read_text().splitlines():
    event = json.loads(line)
    if event["event"] == "tool_call":
        print(f"Tool: {event['name']}")
        print(f"Args: {event['args']}")
```

### 3. Reading Session Transcript

```python
session_id = "019d707b-79ac-735c-894e-001713d09648"
transcript = Path(f"{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/session.log")
print(transcript.read_text())
```

### 4. Changing Log Level at Runtime

```bash
# .env
LOG_LEVEL=WARNING

# Or environment variable
export LOG_LEVEL=DEBUG
openagentd
```

### 5. Adding Custom Session Logging

```python
from app.agent.hooks.session_log import SessionLogHook

# In your hook or setup code:
hook = SessionLogHook(session_id="abc123", agent_name="mybot")
agent = Agent(llm_provider=..., hooks=[hook])

# SessionLogHook writes to {OPENAGENTD_STATE_DIR}/logs/sessions/abc123/mybot.jsonl
```

### 6. Per-Session Sink Management

```python
from app.core.logging_config import add_session_sink, remove_session_sink
from loguru import logger

session_id = "user-session-xyz"

# Start capturing
sink_id = add_session_sink(session_id)
logger.info("User started chat session={}", session_id)

try:
    # ... run agent ...
    pass
finally:
    # Stop capturing
    remove_session_sink(session_id)
    logger.info("Session ended session={}", session_id)
```

---

## Console Output Format

The console sink (stderr) is colorized and human-readable:

```
14:32:05.123 | INFO     | app.agent.agent_loop:run:193 | agent_run_start agent=assistant message_count=5 tools=13 session=abc-123
14:32:07.456 | INFO     | app.agent.agent_loop:run:263 | llm_response agent=assistant iteration=1 elapsed=2.33s content_len=142 reasoning_len=0 tool_calls=1 tokens=500/200/700
14:32:07.457 | INFO     | app.agent.agent_loop:execute:557 | tool_start agent=assistant tool=web_search id=tc_1 args={"query": "..."}
14:32:08.890 | INFO     | app.agent.agent_loop:execute:596 | tool_done agent=assistant tool=web_search elapsed=1.43s result_len=4521
```

**Respects:** `LOG_LEVEL` environment variable

---

## Troubleshooting

### Logs Not Appearing in session.log

**Check:**
- Session ID is included in log message (filter requirement)
- Log level is DEBUG+ (session sink is DEBUG)
- File exists: `{OPENAGENTD_STATE_DIR}/logs/sessions/{session_id}/session.log`

### JSONL File Is Empty

**Check:**
- Session completed successfully (hook is attached)
- SessionLogHook was registered in hooks list
- Agent ran (events only written during `before_agent()` to `after_agent()`)

### Disk Space Growing

**Solution:**
- Application logs auto-rotate at 10 MB (7-day retention)
- Session logs auto-rotate at 5 MB (3-day retention)
- Clean up stale logs manually if needed:
  ```bash
  find ~/.local/state/openagentd/logs -mtime +7 -delete  # production
  find .openagentd/state/logs -mtime +7 -delete          # development
  ```

### Third-Party Noise in Logs

**Already silenced:** `httpx`, `httpcore`, `google.genai`, `uvicorn.access` (set to WARNING)

**To silence others:**
```python
import logging
logging.getLogger("noisy_module").setLevel(logging.WARNING)
```

---

## Related Documentation

- **Architecture:** `documents/docs/architecture.md` (section 6. Logging Architecture)
- **Configuration:** `documents/docs/configuration.md` (LOG_LEVEL env var, Hooks section)
- **Source Code:**
   - `app/core/logging_config.py` — Loguru setup
   - `app/agent/hooks/session_log.py` — SessionLogHook implementation
   - `app/agent/hooks/otel.py` — OpenTelemetry integration
   - `app/agent/agent_loop/` — Agent loop event logging
   - `app/agent/mode/team/member.py` — Team member activation: session sink lifecycle, hook assembly

---

## Summary Table

| Component | Location | Format | Scope | Rotation |
|-----------|----------|--------|-------|----------|
| **App Log** | `{OPENAGENTD_STATE_DIR}/logs/app/app.log` | JSON | All events | 10 MB / 7 days |
| **Session Transcript** | `{OPENAGENTD_STATE_DIR}/logs/sessions/{id}/session.log` | Text | Session only | 5 MB / 3 days |
| **Session Events** | `{OPENAGENTD_STATE_DIR}/logs/sessions/{id}/{agent}.jsonl` | JSONL | Per-agent events | None |
| **Console** | stderr | Text (colored) | Live only | N/A |
