# Debug reference: logs, telemetry, and production installs

Use when the evidence is in log files or OTEL spans: errors over time, slow or
failing tools, provider failures, or a user's installed app.

## Where state lives

| | Dev (`APP_ENV=development`, `make run` / `make dev`) | Production install |
|---|---|---|
| Database | `.openagentd/dev/data/openagentd.db` | `~/.local/share/openagentd/openagentd.db` |
| Logs | `.openagentd/dev/state/logs` | `~/.local/state/openagentd/logs` |
| Telemetry | `.openagentd/dev/state/otel` | `~/.local/state/openagentd/otel` |
| Config, plugins | `.openagentd/dev/config` | `~/.config/openagentd` |

Paths come from `default_dirs` in `appv3/crates/core/src/settings.rs`;
`OPENAGENTD_DATA_DIR`, `_STATE_DIR`, `_CONFIG_DIR`, and `_CACHE_DIR` override them.

Inside `logs/` and `otel/` (written by `appv3/crates/cli/src/logging.rs` and the OTEL hook):

- `logs/app/app.log`: loguru-format JSON, DEBUG+, rotated at 10 MB, 7 days.
- `logs/app/app-error.log`: ERROR+, 14 days. Rotated files: `app.<timestamp>.log`.
- `logs/sessions/<session_id>/session.log`: per-session records.
- `otel/spans/YYYY-MM-DD-HH.jsonl` (hourly spans) and `otel/metrics/YYYY-MM-DD.jsonl`.

Record `name` is the Rust module path (`appv3_tools`, `appv3_agent.session`, …);
messages are `event key=value …` (`tool_start agent= tool= id= args=`,
`tool_error … error=`).

## Scripts

Stdlib Python 3 (optional `orjson`), run from the repository root. Each scans
both the production and dev state roots.

```bash
python3 .agents/skills/oad/debug/scripts/analyze_logs.py --days 7   # WARNING+ grouped by message shape (--level, --log-dir)
python3 .agents/skills/oad/debug/scripts/query_otel.py --days 7     # span, turn, chat, and tool totals; error spans
python3 .agents/skills/oad/debug/scripts/tool_usage.py --days 7     # per-tool volume, latency, errors, shell intent
```

`tool_usage.py` joins spans to `tool_start` / `tool_error` log records by call id.
Its traps, re-read before trusting a similar analysis:

1. **Never divide errors by calls across different windows.** `tool_error`
   records outlive `tool_start` records; the FIXED-OR-LIVE table prints first and
   last error dates so old bugs do not pose as live regressions.
2. **Redundant work is only redundant within a run.** Attribute duplicate calls per `run_id`.
3. **Logged `args=` are cut at 500 chars** (`appv3/crates/tools/src/lib.rs`), so
   strict JSON parsing drops the longest calls (heredocs, inline scripts). Degrade to a regex.

v3 logs no `tool_result_preview` records, so the no-hit columns only fill from v2-era logs.

## Common patterns

- **Tool errors**: grep's 10 s scan limit (`SCAN_TIMEOUT_S` in `tools/src/grep.rs`),
  patch ambiguity (`Found multiple matches`): make sure the model gets an error it can act on.
- **Provider 400s**: check the adapter in `appv3/crates/providers/src/` for the
  provider's role-order and history rules (Anthropic thinking blocks must replay
  unmodified; Google rejects back-to-back user turns).
- **Context length exceeded**: summarization thresholds in `agent/src/hooks/summarization.rs`.
- **History repair noise**: `openai_strip_incomplete_assistant_tool_calls` and
  `openai_drop_orphan_tool_message` warn when interrupted turns are cleaned up on load.
- **Plugins**: v3 loads `.ts` / `.js` plugins from `<config>/plugins` through QuickJS
  (`appv3/crates/jsplugin`); `.py` files there are v2 leftovers and are ignored.
  Dev and production config roots are separate: a plugin fixed in one is not fixed in the other.

## After a fix

Run `make verify-v3` (plus `make verify-web` for wire changes) and re-run the script
that showed the problem over a window that starts after the fix.
