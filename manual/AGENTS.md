# manual/ — Agent Instructions

Manual smoke-test scripts for openagentd.

- **Run as:** `uv run python -m manual.<script> [args]` (try-providers: `uv run python -m manual.try_providers.<script>`).
- **Default target:** dev API at `http://localhost:8000/api`. Source-checkout runs now default to `APP_ENV=development`, so most `uv run python -m manual.<script>` commands hit `.openagentd/dev/` automatically. HTTP smoke scripts should still fail fast rather than accidentally target a production server; override `--base URL` only intentionally.
- **Server needed?** Most scripts need a running server (`make run`). Scripts marked **(no server)** run in-process or read the DB/logs directly.
- **Discoverability:** every script supports `-h/--help`. This file is a map, not a full flag reference.

---

## Team & sessions

Multi-agent turns, history, todos, lifecycle, stop/continue/undo, queued messages.

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `team_chat` | Send a team message, wait for done, print history | `--session`, `--wait` |
| `team_sessions` | List team sessions or inspect one | `--id`, `--all` |
| `session_resolve` | Verify resolve-or-create for normal + coding sessions | `--workspace`, `--base` |
| `team_history` | Print lead + member messages for a session | `SESSION_ID` |
| `team_timeline` | Chronological cross-agent timeline (reads DB) | `SESSION_ID`, `--full`, `--env production` |
| `team_todos` | Print session todos; flag dependency/claim issues | `SESSION_ID` |
| `team_usage` | Per-message usage metadata for a session | `SESSION_ID`, `--base` |
| `team_sse` | Capture + pretty-print every SSE event (incl. lifecycle states) | `--session`, `--wait`, `--out`, `--no-summary` |
| `global_events` | Capture app-global scheduler/title/notification SSE; optionally trigger an action and assert event types | `--trigger-task`, `--message`, `--expect`, `--wait`, `--out`, `--key` |
| `team_spawn` | Exercise `team_manage` spawn/dismiss; stream per-agent content | `--message`, `--session`, `--wait`, `--out` |
| `team_roster_lifecycle` | Fresh sessions carry no roster; stop → members `offline` | `--base`, `--wait` |
| `team_message_idempotency` | Assert each turn's LLM window is an append-only prefix of the next (prompt-cache invariant); summarization rewrites treated as expected | `--session`, `--messages`, `--wait` |
| `team_history_n1_verify` | **(no server)** Differential check that batched member-page query equals the old N+1 loop on seeded edge cases | — |
| `team_open_task_nudge` | Member claims a todo then stops without `team_message`; `--direct` fails unless the hidden nudge fires | `--direct`, `--session`, `--wait` |
| `continue_smoketest` | E2E `/continue`: send → stop → resume → stream → history | `--wait-before-stop`, `--wait` |
| `stop_mid_stream` | User-stop matrix (early/text/tool × undo) with invariant checks | `--only`, `--skip-undo` |
| `support_interrupt` | Provider `support_interrupt` flag contracts; `--live` also hits the API | `--live`, `--base` |
| `stop_additive` | Stop + "I forgot to add…" — final reply must include both messages | `--wait` |
| `queued_injection` | Queued follow-ups splice into a running turn before `done` | `--queue-delay`, `--followup`, `--expect`, `--wait` |
| `cancel_queued_message` | × cancel hard-deletes a queued row (204 → 404, absent from history) | `--queue-delay`, `--base` |
| `queued_file_attach` | Explicit file uploads are accepted on queued messages; cancel deletes persisted files | `--scenario a\|b\|both`, `--base` |
| `undo_mid_second_turn` | Interrupt turn 2, `/undo` (202), boundary rolls back for a clean follow-up | `--base` |
| `fast_mode` | `fast_mode=true` ignored for non-Codex, persists `service_tier=fast` for Codex | `--non-codex-model`, `--codex-model` |
| `mention_attachments` | `@`-mention auto-attach: text fenced + head/tail truncated, image/folder reference-only | `--base` |

```bash
uv run python -m manual.team_chat "Research the latest Python release"
uv run python -m manual.team_chat "Summarise findings" --session <ID>    # follow-up
uv run python -m manual.team_history <SESSION_ID>
uv run python -m manual.team_sse "Ask the explorer to scan memory/" --out .openagentd/sse.jsonl
uv run python -m manual.global_events --trigger-task daily-check --expect session_turn_started --expect desktop_notification
uv run python -m manual.global_events --message "Explain Python context managers" --expect title_update --wait 180
uv run python -m manual.team_open_task_nudge --direct                    # deterministic, no server
uv run python -m manual.stop_mid_stream --only tool                      # single case
uv run python -m manual.fast_mode --codex-model codex:gpt-5.4
```

---

## Observability & utilities

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `health` | `GET /health/ready` + agent roster (tools/skills/vision) | `--base` |
| `provider_models` | List discovered provider models (falls back to catalog) | provider IDs, `--limit` |
| `backend_log` | **(no server)** Summarise repeated WARNING/ERROR/CRITICAL in structured logs | `--env production`, `--path`, `--level`, `--contains`, `--limit`, `--samples` |
| `inspect_prompt` | **(no server)** Reconstruct prompt + tools and count exact tiktoken budgets for the selected payload, every builtin prompt, each tool, and bundled skill bodies | `--dir`, `--agent`, `--encoding`, `--skills-scope`, `--no-team-protocol`, `--out`, `--stats-only`, `--json` |
| `otel_inspect` | Read OTel spans/metrics from `.openagentd/dev/state/otel/*.jsonl` by default | `--env production`, `--session`, `--trace`, `--metrics` |
| `skill_tool_analytics` | **(no server)** Real tool/skill usage frequency from persisted `tool_calls`, split by mode (the DB is the only complete source) | `--env production`, `--since-days`, `--only`, `--top` |
| `scheduler` | Smoke-test the scheduler API (create/trigger/pause/resume/delete + demos) | `list\|create\|trigger\|…`, `--type`, `--every`, `--cron`, `--at`, `--prompt` |
| `patch_tool` | Agent uses filesystem `patch`; verify the tool call | `--base`, `--wait` |
| `lsp_smoketest` | E2E check of LSP diagnostics injection; `--direct` checks bundled Python + managed TypeScript without a server | `--direct`, `--base`, `--wait` |
| `shell_output_delta` | Verify live `tool_output_delta` events from shell output | `--base`, `--message`, `--wait` |
| `bang_shell` | `!command` input dispatches to the shell tool, streams + persists | `--command`, `--expect`, `--session`, `--wait` |
| `tool_result_offload_test` | Verify large tool results are offloaded to the workspace | — |

```bash
uv run python -m manual.health
uv run python -m manual.provider_models openai googlegenai openrouter codex
uv run python -m manual.backend_log --contains drop_partial_tool_call_bad_json
make prompt-budget                                                       # stable human-readable baseline
make prompt-budget-json                                                  # stable JSON for tracking/CI
uv run python -m manual.inspect_prompt --stats-only                      # current configured lead
uv run python -m manual.inspect_prompt --agent explorer --out .openagentd/chat/payload.json
uv run python -m manual.skill_tool_analytics --since-days 7
uv run python -m manual.skill_tool_analytics --env production --since-days 7
uv run python -m manual.otel_inspect --session <ID>                      # or --trace <ID> / --metrics
uv run python -m manual.otel_inspect --env production --session <ID>
uv run python -m manual.scheduler create --type every --every 60 --prompt "Say hello"
uv run python -m manual.bang_shell --command "pwd && echo ok"
```

---

## Summarization & skills

Most require a low `DEFAULT_PROMPT_TOKEN_THRESHOLD` in `app/agent/hooks/summarization.py` to trigger; **(no server)** ones run in-process with a mock LLM.

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `summarization_test` | Drive the summarization hook by sending many turns | — |
| `summarization_max_tokens_test` | Test the `max_token_length` cap on summary output | — |
| `summarization_improvements_test` | **(no server)** P2 tool-result context, P5 merge-vs-fresh, P6 min-delta guard | — |
| `summarization_sse` | Capture `summarization_start/_content/_end` SSE; deltas reconstruct the summary | `--session`, `--warmup`, `--wait`, `--out` |
| `compaction_cache` | Cache-first summarization; `--direct` (no server) checks prefix shape + multi-skill retention; live checks prompt-cache reads | `--direct`, `--turns`, `--wait`, `--min-cache-ratio` |
| `skill_dedupe` | **(no server)** Duplicate skill loads replay the body; summarization keeps only the first full skill pair | — |

```bash
uv run python -m manual.summarization_improvements_test                  # no server
uv run python -m manual.summarization_sse --out .openagentd/state/summ_sse.jsonl
uv run python -m manual.compaction_cache --direct                        # no server
uv run python -m manual.compaction_cache --turns 6 --wait 180 --min-cache-ratio 0.10
uv run python -m manual.skill_dedupe
```

---

## Media generation

Exercise the image/video backends and the `generate_image` tool directly — **no server, no agent loop**. Require provider keys (`OPENAI_API_KEY` / `GOOGLE_API_KEY`); outputs land in `/tmp/`.

| Script | Purpose | Key flags |
|--------|---------|-----------|
| `image_tool_smoketest` | Full `generate_image` tool path (load inputs → backend → sandbox write → markdown) | `--model` |
| `image_edit_smoketest` | OpenAI image **edit** backend (generate 2 PNGs → compose) | `--model` |
| `video_smoketest` | Veo video backend | `--mode text\|image\|interp\|ref`, `--img`, `--model` |

```bash
uv run python -m manual.image_tool_smoketest
uv run python -m manual.video_smoketest --mode text
```

---

## Provider tests (`try_providers/`)

Hit LLM provider APIs directly — **no server required**, uses API keys from `.env`. Most accept `--model`, `--tools`/`--real-tools`, `--level`, `--no-stream`, `--simple`. OpenRouter/Copilot/Codex exit `2` for expected provider-side errors (insufficient credits, unsupported model).

| Script | Notes |
|--------|-------|
| `try_openai` | Completions + Responses (`--responses`) |
| `try_openai_chat_completions_tools` | Chat Completions API with tools (no Responses) |
| `try_openai_responses_tools` | Responses API with tools |
| `try_openrouter` | Via retry/error classification |
| `try_copilot` | Run `uv run openagentd auth copilot` first |
| `try_codex` | Run `uv run openagentd auth codex` first |
| `try_googlegenai` | Gemini |
| `try_vertexai` | Vertex AI |
| `try_bedrock` | AWS Bedrock; auth via `AWS_BEDROCK_PROFILE`/`--profile`, region `AWS_BEDROCK_REGION`/`--region` |
| `try_zai` | ZAI |
| `try_deepseek` | DeepSeek (`DEEPSEEK_API_KEY`) |
| `try_ollama` | Local daemon; cloud via `-cloud` model suffix after `ollama signin` |
| `try_xai` | xAI/Grok; Chat Completions or Responses via `--level` |
| `try_router9` | Local 9Router; requires a model ID exposed by the running router |
| `try_continue_probe` | Probe whether providers continue from a trailing-assistant message (informs `/continue` design); `--model` |

```bash
uv run python -m manual.try_providers.try_openai
uv run python -m manual.try_providers.try_codex --model gpt-5.5 --level low
uv run python -m manual.try_providers.try_googlegenai --real-tools
uv run python -m manual.try_providers.try_ollama --model kimi-k2.6-cloud --simple
```

---

## Recipe: verify date injection is frozen at session creation

```bash
uv run python -m manual.team_chat "What date is in your system prompt? Reply with just the date."
uv run python -m manual.team_chat "What date is in your system prompt now?" --session <ID>   # must match

# Decode the expected date from the UUIDv7 session id
uv run python -c "
from uuid import UUID; from datetime import datetime, timezone
ts_ms = UUID('<ID>').int >> 80
print(datetime.fromtimestamp(ts_ms/1000, tz=timezone.utc).strftime('%Y-%m-%d'))"
```
