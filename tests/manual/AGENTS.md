# tests/manual/ — Manual Scenario Scripts

Standalone Python scripts that exercise `chat_service` end-to-end against an
in-memory SQLite database. They are **not** picked up by pytest — run them
directly when verifying dynamic message visibility, undo/redo behaviour, or
compaction logic after changes to `chat_service.py` or
`chat_service_revert.py`.

## Run

```bash
uv run python tests/manual/manual_scenarios.py
uv run python tests/manual/extended_scenarios.py
uv run python tests/manual/mention_scenarios.py
```

Each script prints a ✅/❌ line per check and exits non-zero on any failure.

## Files

| File | Scenarios | What it covers |
|---|---|---|
| `manual_scenarios.py` | A – G (21 checks) | Core paths: normal compaction, undo summary (user + LLM view), two-summary over-restore guard, queued message visibility, redo, restore-all |
| `extended_scenarios.py` | H – P (24 checks) | Edge cases: no-undo baseline, `hidden_from_user` summary, `heal_orphaned` respects boundary, double-undo layering, `keep_last_n` undo, empty session, plain-message undo, Anthropic replay sanitization for interrupted tool stubs |
| `mention_scenarios.py` | A – I (30 checks) | `@mention` context injection: code file extensions (.ts/.py/.yaml/…), directory listing (with/without trailing slash), binary skip, image/document hint blocks, safety check, non-existent path, line references, multiple mentions, path traversal rejection |

## When to re-run

- Any change to `get_dynamically_visible_messages` in `chat_service_revert.py`
- Any change to `get_messages`, `get_messages_for_llm`, or `heal_orphaned_tool_calls` in `chat_service.py`
- Any change to `undo_session_messages`, `redo_session_messages`, or `exclude_messages_before_summary`
- Any change to `build_mention_context_blocks`, `_read_mention_as_attachment`, or `_safe_join*` in `app/api/routes/team/_helpers.py`

## Adding new scenarios

Append a new lettered block to `extended_scenarios.py` following the existing
pattern. Use the `check(label, got, expected)` helper — it accumulates results
and prints the final tally. Keep each scenario in its own `async with factory()
as s:` block so sessions are fully isolated.
