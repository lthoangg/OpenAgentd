# manual/ — Agent Instructions

Manual smoke-test scripts for openagentd. All scripts target `http://localhost:8000/api` by default.

**Prerequisites:** server running (`make run`), invoked as `uv run python -m manual.<script>`.

---

## Scripts

### Team (multi-agent)

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `team_chat.py` | Send a team message, wait for done, print full history | `--session ID`, `--wait N` |
| `team_sessions.py` | List team sessions or inspect one | `--id ID`, `--all` |
| `team_history.py` | Print lead + member messages for a session | positional `SESSION_ID` |
| `team_timeline.py` | Chronological cross-agent timeline (reads DB directly) | `SESSION_ID`, `--full` |
| `team_sse.py` | Capture + pretty-print every SSE event from a team turn (timing, per-agent attribution, counts) | `--session ID`, `--wait N`, `--out FILE`, `--no-summary` |

```bash
# New team turn
uv run python -m manual.team_chat "Research the latest Python release"

# Follow-up
uv run python -m manual.team_chat "Summarise your findings" --session <ID>

# Full history after a run
uv run python -m manual.team_history <SESSION_ID>

# Chronological timeline across all agents
uv run python -m manual.team_timeline <SESSION_ID>

# Capture every SSE event with timing + per-agent attribution
uv run python -m manual.team_sse "Ask the explorer to scan memory/"
uv run python -m manual.team_sse "msg" --out .openagentd/sse.jsonl     # save raw JSONL
```

---

### Dream / wiki

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `dream.py status` | Show unprocessed sessions + note files (reads DB directly) | — |
| `dream.py run` | Trigger dream via `POST /api/dream/run` (server required) | `--base URL` |
| `dream.py run --direct` | Trigger dream directly via DB (no server required) | — |
| `dream.py log` | Show `dream_log` entries (sessions processed) | `--notes`, `--all` |
| `wiki.py tree` | Show full wiki tree (system / topics / notes) | `--unprocessed` |
| `wiki.py read PATH` | Print a wiki file's contents | — |
| `wiki.py write PATH` | Write a wiki file (content from `--content` or stdin) | `--content` |
| `wiki.py delete PATH` | Delete a wiki file (USER.md and INDEX.md blocked) | — |
| `note.py TEXT` | Append a timestamped note entry to wiki/notes/{date}.md | — |
| `note.py --list` | List all note files with size and line count | — |
| `note.py --cat FILE` | Print contents of a note file | — |

```bash
# What hasn't been processed yet?
uv run python -m manual.dream status

# Trigger dream (server must be running)
uv run python -m manual.dream run

# Trigger dream without the server
uv run python -m manual.dream run --direct

# Show session processing log
uv run python -m manual.dream log

# Show note processing log
uv run python -m manual.dream log --notes

# Show both logs
uv run python -m manual.dream log --all

# Show wiki tree (all files)
uv run python -m manual.wiki tree

# Show only notes not yet processed by dream
uv run python -m manual.wiki tree --unprocessed

# Read a wiki file
uv run python -m manual.wiki read USER.md
uv run python -m manual.wiki read topics/auth.md

# Write a wiki file (from --content flag or stdin)
uv run python -m manual.wiki write topics/test.md --content "---\ndescription: test\n---\nbody"
echo "content" | uv run python -m manual.wiki write topics/test.md

# Delete a wiki file
uv run python -m manual.wiki delete topics/test.md

# Seed a test note (no server required)
uv run python -m manual.note "User prefers Vim."
uv run python -m manual.note "Second note."

# List all note files
uv run python -m manual.note --list

# Print a note file
uv run python -m manual.note --cat 2026-04-30-manual-test.md
```

---

### Observability / utilities

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `health.py` | `GET /health/ready` + team agent roster with tools/skills/vision | `--base URL` |
| `inspect_prompt.py` | Reconstruct full LLM payload (system prompt + tools JSON) — **no server required** | `--dir`, `--agent`, `--no-date`, `--date`, `--out`, `--stats-only` |
| `otel_inspect.py` | Read OTel spans/metrics from `.openagentd/otel/` JSONL files | `--session ID`, `--trace ID`, `--metrics` |
| `summarization_test.py` | Drive summarization hook by sending many turns | requires low `token_threshold` in `.openagentd/config/summarization.md` |
| `summarization_max_tokens_test.py` | Test max_token_length cap on summary output | requires `max_token_length` set in `.openagentd/config/summarization.md` |
| `tool_result_offload_test.py` | Verify large tool results are offloaded to workspace | — |

```bash
# Check server health + configured agents
uv run python -m manual.health

# Print char/token breakdown for the chat agent payload
uv run python -m manual.inspect_prompt --stats-only

# Full JSON payload (system_prompt + tools) to stdout
uv run python -m manual.inspect_prompt

# Save payload to file (paste into tokenizer)
uv run python -m manual.inspect_prompt --out .openagentd/chat/payload.json

# Inspect a specific agent from the agents directory
uv run python -m manual.inspect_prompt --agent explorer

# Without date injection (static payload only)
uv run python -m manual.inspect_prompt --no-date --stats-only

# Inspect OTel spans for a session
uv run python -m manual.otel_inspect --session <ID>

# Print full trace tree
uv run python -m manual.otel_inspect --trace <TRACE_ID>

# Metrics summary
uv run python -m manual.otel_inspect --metrics
```

### Provider tests (`try_providers/`)

Hit LLM provider APIs directly — **no server required**, uses API keys from `.env`.

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `try_providers/try_openai.py` | Test OpenAI provider (completions + responses) | `--model`, `--level`, `--responses` |
| `try_providers/try_copilot.py` | Test Copilot provider (requires `uv run openagentd auth copilot` first) | `--model`, `--level` |
| `try_providers/try_googlegenai.py` | Test Google GenAI (Gemini) provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_vertexai.py` | Test Vertex AI provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_zai.py` | Test ZAI provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_geminicli.py` | Test GeminiCLI provider (OAuth, no API key) | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_ollama.py` | Test Ollama provider (local daemon; cloud via `-cloud` suffix after `ollama signin`) | `--model`, `--tools`, `--real-tools`, `--no-stream`, `--simple` |

```bash
uv run python -m manual.try_providers.try_openai
uv run python -m manual.try_providers.try_copilot --model gpt-5.4-mini
uv run python -m manual.try_providers.try_googlegenai
uv run python -m manual.try_providers.try_googlegenai --model gemini-3.1-flash-lite-preview --simple
uv run python -m manual.try_providers.try_googlegenai --real-tools
uv run python -m manual.try_providers.try_vertexai --simple
uv run python -m manual.try_providers.try_zai --simple
uv run python -m manual.try_providers.try_geminicli --simple
uv run python -m manual.try_providers.try_ollama --simple
uv run python -m manual.try_providers.try_ollama --model kimi-k2.6-cloud --simple
```

---

## Common testing patterns

**Inspect a team session:**
```bash
uv run python -m manual.team_sessions --id <SESSION_ID>
```

**Full history for a team session:**
```bash
uv run python -m manual.team_history <SESSION_ID>
```

**Chronological cross-agent timeline:**
```bash
uv run python -m manual.team_timeline <SESSION_ID>
```

**Verify date injection is frozen at session creation:**
```bash
# Turn 1 — note the session ID
uv run python -m manual.team_chat "What date is in your system prompt? Reply with just the date."

# Turn 2 — same session, should return identical date
uv run python -m manual.team_chat "What date is in your system prompt now?" --session <ID>

# Decode expected date from the UUIDv7 session ID
uv run python -c "
from uuid import UUID
from datetime import datetime, timezone
sid = '<ID>'
ts_ms = UUID(sid).int >> 80
print(datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d'))
"
```
