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
| `session_resolve.py` | Verify resolve-or-create for normal and coding sessions | `--workspace PATH`, `--base URL` |
| `team_history.py` | Print lead + member messages for a session | positional `SESSION_ID` |
| `team_message_idempotency.py` | Drive a multi-agent, multi-turn run and assert each turn's `get_messages_for_llm` window (lead + every member) is an append-only prefix of the next — the prompt-cache invariant. Flags mid-history mutations; treats summarization prefix rewrites as EXPECTED. Surfaces roster-change rows to confirm roster is appended history, not a system-prompt mutation | `--session ID`, `--messages ...`, `--wait N`, `--base URL` |
| `team_timeline.py` | Chronological cross-agent timeline (reads DB directly) | `SESSION_ID`, `--full` |
| `team_todos.py` | Print session todos and flag dependency/claim consistency issues | positional `SESSION_ID` |
| `team_open_task_nudge.py` | Drive a member that claims an assigned todo then incorrectly stops without `team_message`; deterministic `--direct` mode fails unless the hidden open-task nudge is observed | `--direct`, `--session ID`, `--wait N`, `--base URL` |
| `team_sse.py` | Capture + pretty-print every SSE event from a team turn, including lifecycle states (`idle`, `working`, `offline`, `error`) | `--session ID`, `--wait N`, `--out FILE`, `--no-summary` |
| `team_spawn.py` | Drive a turn that exercises `team_manage` spawn/dismiss; snapshots `/team/agents`, streams per-agent content, prints spawn/dismiss and lifecycle timelines | `--message TEXT`, `--session ID`, `--wait N`, `--out FILE`, `--no-color`, `--no-history` |
| `team_roster_lifecycle.py` | Verify fresh sessions do not carry member rosters and stop moves running members to `offline` | `--base URL`, `--wait N` |
| `continue_smoketest.py` | End-to-end test of `/continue`: send long prompt, wait, interrupt, inspect truncated assistant row, dispatch `/continue`, stream resumption inline, print final history | `--wait-before-stop N`, `--wait N`, `--base URL` |
| `stop_mid_stream.py` | Drive the user-stop matrix (early / text / tool phases, with and without `/undo`) and check phase-agnostic invariants on the persisted history + follow-up SSE. Exits non-zero on any invariant failure | `--only NAME`, `--skip-undo`, `--base URL` |
| `stop_additive.py` | Verify the Stop + additional-message ("I forgot to add ...") additive semantic — send msg_A, Stop, send msg_B, assert the final assistant reply incorporates both. Exits non-zero if either word is missing | `--wait N`, `--base URL` |
| `queued_injection.py` | Verify queued follow-ups splice into the running turn before `done`: send a slow tool prompt, queue multiple follow-ups, assert `queued_turn_start` arrives before completion, rows become visible history, and the final answer includes exact queued tokens | `--queue-delay N`, `--between-delay N`, `--followup TEXT`, `--expect TEXT`, `--wait N`, `--base URL` |
| `cancel_queued_message.py` | Verify the × cancel flow hard-deletes a queued row: queue a follow-up, DELETE it (assert 204), DELETE again (assert 404 — row gone), stream to done, assert no `queued_turn_start` and no history entry for that id | `--queue-delay N`, `--base URL` |
| `mention_attachments.py` | Smoke-test `@`-mention auto-attachment: text file fenced, large text head+tail truncated, image and folder mentions are reference-only (no attachment). Exits non-zero on any invariant failure | `--base URL` |
| `undo_mid_second_turn.py` | Two-turn `/undo` scenario: turn 1 completes, turn 2 is interrupted mid-stream, `/undo` must return 202 (lead is idle post-Stop, busy-member guard does not fire) and the boundary must roll back so a follow-up runs without the interrupted prompt in context | `--base URL` |
| `fast_mode.py` | Verify `/team/chat` accepts provider-neutral `fast_mode=true`, ignores it for non-Codex models, and can persist `extra.service_tier=fast` for a Codex model without consuming LLM tokens | `--non-codex-model ID`, `--codex-model ID`, `--base URL` |
| `loop_smoketest.py` | Verify coding-mode `/loop` config/start/stop reinjects the exact prompt after team idle | `--workspace PATH`, `--budget 5|10|20|50`, `--prompt TEXT`, `--wait N`, `--base URL` |

```bash
# New team turn
uv run python -m manual.team_chat "Research the latest Python release"

# Follow-up
uv run python -m manual.team_chat "Summarise your findings" --session <ID>

# Resolve/create active sessions without sending a message
uv run python -m manual.session_resolve
uv run python -m manual.session_resolve --workspace /path/to/repo

# Full history after a run
uv run python -m manual.team_history <SESSION_ID>

# Chronological timeline across all agents
uv run python -m manual.team_timeline <SESSION_ID>

# Verify LLM message windows stay append-only across turns (prompt-cache idempotency)
uv run python -m manual.team_message_idempotency
uv run python -m manual.team_message_idempotency --session <ID>     # continue an existing lead session

# Inspect task ownership/dependencies
uv run python -m manual.team_todos <SESSION_ID>

# Verify members with open assigned todos are nudged if they stop without team_message
uv run python -m manual.team_open_task_nudge --direct              # deterministic, no server
uv run python -m manual.team_open_task_nudge                       # live-server mode; model-dependent
uv run python -m manual.team_open_task_nudge --session <ID>

# Capture every SSE event with timing + per-agent attribution
uv run python -m manual.team_sse "Ask the explorer to scan memory/"
uv run python -m manual.team_sse "msg" --out .openagentd/sse.jsonl     # save raw JSONL

# Smoke-test team_manage spawn/dismiss + stream per-agent content
uv run python -m manual.team_spawn                                     # default prompt forces multi-blueprint spawn
uv run python -m manual.team_spawn --message "Spawn one executor and ask it to count to three"
uv run python -m manual.team_spawn --out .openagentd/spawn.jsonl       # also save raw JSONL

# Smoke-test per-session roster isolation and stop/offline lifecycle
uv run python -m manual.team_roster_lifecycle

# End-to-end /continue smoke test: send → stop → /continue → stream → history
uv run python -m manual.continue_smoketest
uv run python -m manual.continue_smoketest --wait-before-stop 5     # later stop

# Stop-mid-stream matrix (early/text/tool × undo/no-undo) with invariant checks
uv run python -m manual.stop_mid_stream
uv run python -m manual.stop_mid_stream --only tool                 # just the tool-call case
uv run python -m manual.stop_mid_stream --skip-undo                 # skip the /undo half

# Stop + additional-message ("I forgot to add ...") additive contract check
uv run python -m manual.stop_additive                               # default 0.3s wait → forces [user, user] adjacency
uv run python -m manual.stop_additive --wait 1.5                    # mid-stream interrupt

# Queued follow-up injection: queue while a slow tool turn is running, verify splice before done
uv run python -m manual.queued_injection

# Cancel a queued message: verify DELETE hard-removes the row (204 → 404, absent from history)
uv run python -m manual.cancel_queued_message

# Two-turn /undo: complete turn 1, interrupt turn 2 mid-stream, /undo, verify boundary rolled back
uv run python -m manual.undo_mid_second_turn

# Fast mode: non-Codex ignore path; pass --codex-model when Codex is configured
uv run python -m manual.fast_mode
uv run python -m manual.fast_mode --codex-model codex:gpt-5.4

# Coding /loop controls: configure, start, observe reinjection, stop
uv run python -m manual.loop_smoketest
uv run python -m manual.loop_smoketest --budget 5 --prompt "Reply exactly LOOP-SMOKE-OK. Do not use tools."

# @-mention attachment behaviour (text fenced+truncated, image/folder reference-only)
uv run python -m manual.mention_attachments
```

---

### Dream / wiki

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `dream.py status` | Show unprocessed sessions + note files (reads DB directly) | — |
| `dream.py run` | Trigger dream via `POST /api/dream/run` (server required) | `--base URL` |
| `dream.py run --direct` | Trigger dream directly via DB (no server required) | — |
| `dream.py log` | Show `dream_log` entries (sessions processed) | `--notes`, `--all` |
| `dream.py unmark` | Requeue a processed session or note | `--session ID`, `--note FILE` |
| `dream.py lint` | Trigger wiki lint via `POST /api/dream/lint` or directly | `--direct`, `--base URL` |
| `memory.py tree` | Show Memory v2 tree (`SCHEMA.md`, `INDEX.md`, `LOG.md`, `wiki/`, `imports/`, `notes/`) | — |
| `memory.py search QUERY` | Search Memory v2 markdown files; optionally include raw DB messages | `--raw`, `--limit N` |
| `memory.py maintain` | Run the deterministic Dream v2 maintainer directly; compiles pending sources into flat `wiki/*.md` pages and records `memory_processed_sources` | `--limit N` |
| `memory.py index` | Print Memory v2 `INDEX.md` or placeholder | — |
| `memory.py vector status` | Show optional Memory v2 vector backend status (`disabled` by default; `turbovec` currently reports planned/unavailable) | — |
| `memory_eval_fixture.py` | Seed a synthetic Memory v2 corpus + 32-row JSONL fixture for manual benchmark runs; optionally run the benchmark immediately | `--data PATH`, `--run`, `--mode`, `--top-k`, `--debug-hits`, `--write-candidates` |
| `memory_bench.py longmemeval` | Run local LongMemEval-style deterministic retrieval/injection harness with negative/abstention, candidate false-positive, and per-type metrics; no dataset download | `--mode raw|wiki|wiki-plus-raw|injection`, `--data PATH`, `--limit N`, `--top-k N`, `--debug-hits`, `--write-candidates` |
| `wiki.py tree` | Show full wiki tree (system, knowledge dirs, notes) | `--unprocessed` |
| `wiki.py read PATH` | Print a wiki file's contents | — |
| `wiki.py write PATH` | Write a wiki file (content from `--content` or stdin) | `--content` |
| `wiki.py delete PATH` | Delete a wiki file (USER.md, INDEX.md, LOG.md blocked) | — |
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

# Requeue a session/note that was marked processed too early
uv run python -m manual.dream unmark --session <SESSION_ID>
uv run python -m manual.dream unmark --note 2026-05-17.md

# Memory v2 tree/search helpers
uv run python -m manual.memory tree
uv run python -m manual.memory search "what does Hoang prefer?"
uv run python -m manual.memory search "memory schema" --raw --limit 5
uv run python -m manual.memory index
uv run python -m manual.memory vector status

# Compile pending Memory v2 sources into flat wiki pages
uv run python -m manual.memory maintain --limit 1

# LongMemEval-style retrieval baseline over a local dataset file
# Rows may include type/question_type and negative/answerable flags for grouped abstention metrics.
uv run python -m manual.memory_bench longmemeval --mode raw --limit 20 --top-k 10 --data PATH
uv run python -m manual.memory_bench longmemeval --mode wiki --limit 20 --top-k 10 --data PATH
uv run python -m manual.memory_bench longmemeval --mode wiki-plus-raw --limit 20 --top-k 10 --data PATH
uv run python -m manual.memory_bench longmemeval --mode injection --limit 20 --top-k 10 --data PATH
uv run python -m manual.memory_bench longmemeval --mode wiki --top-k 5 --data PATH --debug-hits --write-candidates

# Seed and run the synthetic Memory v2 benchmark fixture (writes into the configured OPENAGENTD_WIKI_DIR)
uv run python -m manual.memory_eval_fixture
uv run python -m manual.memory_eval_fixture --run
uv run python -m manual.memory_eval_fixture --run --debug-hits --write-candidates
uv run python -m manual.memory_eval_fixture --mode injection --run --debug-hits --write-candidates
OPENAGENTD_WIKI_DIR=/tmp/openagentd-memory-eval uv run python -m manual.memory_eval_fixture --run

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
| `provider_models.py` | List discovered provider models, falling back to catalog defaults | provider IDs, `--limit N` |
| `inspect_prompt.py` | Reconstruct full LLM payload (system prompt + tools JSON) — **no server required** | `--dir`, `--agent`, `--no-date`, `--date`, `--out`, `--stats-only` |
| `patch_tool.py` | Tell an agent to use filesystem `patch` and verify the tool call | `--base URL`, `--wait N` |
| `otel_inspect.py` | Read OTel spans/metrics from `.openagentd/otel/` JSONL files | `--session ID`, `--trace ID`, `--metrics` |
| `summarization_test.py` | Drive summarization hook by sending many turns | requires low `DEFAULT_PROMPT_TOKEN_THRESHOLD` in `app/agent/hooks/summarization.py` |
| `summarization_max_tokens_test.py` | Test max_token_length cap on summary output | requires `DEFAULT_MAX_TOKEN_LENGTH` set in `app/agent/hooks/summarization.py` |
| `summarization_sse.py` | Capture `summarization_start` / `_content` / `_end` SSE events from a team turn and verify deltas reconstruct the final summary | `--session ID`, `--warmup N`, `--wait N`, `--out FILE` |
| `compaction_cache.py` | Live smoke for cache-first summarization; checks prompt-cache reads during compaction | `--turns N`, `--wait N`, `--session ID` |
| `tool_result_offload_test.py` | Verify large tool results are offloaded to workspace | — |
| `shell_output_delta.py` | Verify live `tool_output_delta` events from shell output | `--base URL`, `--message TEXT`, `--wait N` |
| `bang_shell.py` | Verify opencode-style `!command` input dispatches directly to the shell tool, streams shell events, and persists shell history | `--base URL`, `--command TEXT`, `--expect TEXT`, `--session ID`, `--wait N` |

```bash
# Check server health + configured agents
uv run python -m manual.health

# Check provider model listing
uv run python -m manual.provider_models openai googlegenai openrouter nvidia copilot codex

# Print char/token breakdown for the chat agent payload
uv run python -m manual.inspect_prompt --stats-only

# Full JSON payload (system_prompt + tools) to stdout
uv run python -m manual.inspect_prompt

# Smoke-test the patch tool directly
uv run python -m manual.patch_tool

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

# Verify live shell output deltas
uv run python -m manual.shell_output_delta

# Verify `!command` shell dispatch from the input-bar/API path
uv run python -m manual.bang_shell
uv run python -m manual.bang_shell --command "pwd && echo oad-bang-shell-ok"

# Verify summarisation SSE events fire on a team turn (needs low token_threshold)
uv run python -m manual.summarization_sse
uv run python -m manual.summarization_sse --session <ID>                 # follow-up on existing session
uv run python -m manual.summarization_sse --out .openagentd/state/summ_sse.jsonl

# Verify summarization prompt-cache reuse during live compaction
uv run python -m manual.compaction_cache --turns 6 --wait 180
```

### Provider tests (`try_providers/`)

Hit LLM provider APIs directly — **no server required**, uses API keys from `.env`.

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `try_providers/try_openai.py` | Test OpenAI provider (completions + responses) | `--model`, `--level`, `--responses` |
| `try_providers/try_copilot.py` | Test Copilot provider (requires `uv run openagentd auth copilot` first) | `--model`, `--level` |
| `try_providers/try_codex.py` | Test Codex provider (requires `uv run openagentd auth codex` first) | `--model`, `--level`, `--no-stream`, `--simple` |
| `try_providers/try_googlegenai.py` | Test Google GenAI (Gemini) provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_vertexai.py` | Test Vertex AI provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_zai.py` | Test ZAI provider | `--model`, `--level`, `--tools`, `--real-tools` |
| `try_providers/try_ollama.py` | Test Ollama provider (local daemon; cloud via `-cloud` suffix after `ollama signin`) | `--model`, `--tools`, `--real-tools`, `--no-stream`, `--simple` |

```bash
uv run python -m manual.try_providers.try_openai
uv run python -m manual.try_providers.try_copilot --model gpt-5.4-mini
uv run python -m manual.try_providers.try_codex --model gpt-5.5 --level low
uv run python -m manual.try_providers.try_googlegenai
uv run python -m manual.try_providers.try_googlegenai --model gemini-3.1-flash-lite-preview --simple
uv run python -m manual.try_providers.try_googlegenai --real-tools
uv run python -m manual.try_providers.try_vertexai --simple
uv run python -m manual.try_providers.try_zai --simple
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

**Check session todos:**
```bash
uv run python -m manual.team_todos <SESSION_ID>
```

**Verify the member open-task nudge:**
```bash
uv run python -m manual.team_open_task_nudge --direct
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
