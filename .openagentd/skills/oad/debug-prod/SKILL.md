---
name: oad/debug-prod
description: Workflow and patterns for inspecting, analyzing, and diagnosing production logs and OTEL telemetry in OpenAgentd.
---

Production inspection and telemetry analysis workflow for OpenAgentd instances.

## 1. Locate Log and Telemetry Directories

OpenAgentd stores state under XDG roots based on `APP_ENV`:

- **Production mode (`APP_ENV=production`):**
  - Logs: `~/.local/state/openagentd/logs`
  - Telemetry: `~/.local/state/openagentd/otel`
- **Development mode (`APP_ENV=development`):**
  - Logs: `.openagentd/dev/state/logs`
  - Telemetry: `.openagentd/dev/state/otel`

### File Layout

- `logs/app/app.log` — Full JSON loguru stream (DEBUG+, rotated at 10 MB, 7-day retention).
- `logs/app/app-error.log` — Errors only (ERROR+, rotated at 10 MB, 14-day retention).
- `logs/app/app.YYYY-MM-DD_HH-MM-SS_*.log` — Rotated past app logs.
- `logs/sessions/<session_id>/session.log` — Per-session filtered logs.
- `otel/spans/YYYY-MM-DD-HH.jsonl` — Hourly OpenTelemetry trace spans.
- `otel/metrics/YYYY-MM-DD.jsonl` — Daily OpenTelemetry metric rollups.

---

## 2. Log Analysis Workflow

Use the dedicated log analysis script to parse loguru JSON records, apply time cutoffs, and group distinct error patterns across log files:

```bash
uv run python .openagentd/skills/oad/debug-prod/scripts/analyze_logs.py --days 7
```

Script location: `.openagentd/skills/oad/debug-prod/scripts/analyze_logs.py`

---

## 3. OpenTelemetry Telemetry Querying via DuckDB

Use the dedicated OTEL telemetry querying script (powered by DuckDB) to inspect hourly span JSONL files (`read_json`), aggregate metrics, and list error spans:

```bash
uv run python .openagentd/skills/oad/debug-prod/scripts/query_otel.py --days 7
```

Script location: `.openagentd/skills/oad/debug-prod/scripts/query_otel.py`

---

## 3b. Tool Usage & Usefulness Audit

Answers "is any tool underused, slow, failing, or not earning its context?" by joining spans (volume, latency, result bytes) to loguru records (arguments, result text) per tool-call id:

```bash
uv run python .openagentd/skills/oad/debug-prod/scripts/tool_usage.py --days 7
```

Script location: `.openagentd/skills/oad/debug-prod/scripts/tool_usage.py`

Reports volume/cost, outcome quality (no-hit and error rates), a FIXED-OR-LIVE error-date table, unknown tool names the model guessed, repeated identical calls per run, and what `shell` is standing in for.

Three measurement traps it encodes — re-read these before trusting any similar analysis:

1. **Never divide errors by calls across different windows.** `tool_error` records outlive `tool_start` records, which once read as "grep fails 44% of calls" for a bug fixed weeks earlier. The FIXED-OR-LIVE table prints first/last error dates per tool so history cannot pose as a live regression.
2. **Redundant work is only redundant within a run.** Attribute duplicate calls per `run_id`; counting across sessions turned legitimate reuse into 111 fake duplicate `skill` loads.
3. **Logged `args=` are truncated at 500 chars** (`tool_executor.py`), so strict `json.loads` silently drops the longest ~16% of shell calls — exactly the heredocs and inline python. That skew reported "shell is used to read files 78%" when the real leaders are tests/build 30% and git 18%. Likewise, `tool_result_preview` carries no call id and parallel calls interleave, so pair previews to tools in aggregate, never to the most recent start (that undercounted glob's no-hit rate as 14% instead of 32%).

---

## 4. Common Production Patterns & Diagnostic Checklists

### A. Tool Execution & Sandbox Failures
- **Single file vs directory targets (`NotADirectoryError`):**
  Check `app/agent/tools/builtin/filesystem/grep.py` and `glob.py`. Ensure tools handle file targets seamlessly when passed as `directory` argument.
- **Diff / Patch ambiguity (`Found multiple matches` / `Could not find oldString`):**
  Ensure LLM receives clear error output from tool executor so it can re-read context and supply unique surrounding lines.
- **Regex timeouts (`grep scan timed out after 10s`):**
  Occurs on broad directory sweeps or complex regex. Check `_SCAN_TIMEOUT_S`.

### B. Provider API & Protocol Violations
- **Gemini turn order / role rules (`HTTP 400 INVALID_ARGUMENT`):**
  Gemini APIs reject back-to-back `user` role `Content` blocks. Consecutive `ToolMessage` outputs must be combined into a single `Content(role="user", parts=[FunctionResponse...])` block. Check `_convert_messages_to_gemini` in provider and OAuth plugins.
- **Anthropic thinking block invariants (`thinking` / `redacted_thinking`):**
  Anthropic models reject requests if assistant thinking blocks are modified or stripped when replaying history. Ensure `reasoning_signature` and `redacted_thinking_blocks` are preserved.
- **Context length exceeded (`HTTP 400 context_length_exceeded`):**
  Check summarization thresholds (`app/agent/hooks/summarization.py`) and message history context boundaries.

### C. Log Noise & Level Calibration
- **Unconfigured optional MCP integrations:**
  Optional MCP server warnings (e.g. `agent_unknown_mcp_server`) should use `DEBUG` log level so disabled/unconfigured MCP servers do not flood log sinks.
- **Session history sanitization:**
  Normal cleanup of interrupted turns (`deserialize_strip_incomplete_assistant_tool_calls`, `deserialize_drop_orphan_tool_message`) should use `DEBUG` log level during normal session loads.

---

## 5. Verification Protocol

After diagnosing and applying fixes:

1. **Verify Backend Suite:**
   ```bash
   make verify-backend
   ```
2. **Verify Service Scenarios:**
   ```bash
   make scenarios
   ```
3. **Verify Plugin Overrides (if applicable):**
   - Ensure plugin overrides in dev (`.openagentd/dev/config/plugins/`) are synchronized to active production config roots (`~/.config/openagentd/plugins/`).
   - Perform syntax verification (`python3 -m py_compile <plugin_path>`).
