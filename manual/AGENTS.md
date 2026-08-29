# Live and Provider Diagnostics Guide

`manual/` contains operator/developer smoke scripts. It is not the pytest
suite: scripts may require a running local server, configured providers, a
local database/log tree, or external credentials.

## Running safely

- Run modules from the repository root as
  `uv run python -m manual.<module> --help`.
- Most HTTP scripts default to the development API under
  `http://localhost:8000/api`; start it with `make run` or `make dev`.
  Override `--base` only intentionally and never aim mutation scripts at a
  production server for routine testing.
- Modules under `manual.try_providers` call external provider APIs and may
  incur cost. Run them only with the intended model/account credentials.
- Scripts marked no-server in their module help operate in process or inspect
  local state. Use `--env production` only when production data is the explicit
  target.
- Do not print, persist, or add provider keys, access tokens, or copied `.env`
  contents. Put generated captures under ignored `.openagentd/` state or a
  temporary directory.

## Navigation

- Session lifecycle and SSE: `team_chat`, `team_sessions`, `team_history`,
  `team_timeline`, `team_sse`, `team_todos`, queued/stop/undo
  scripts, and durable-question diagnostics.
- Runtime health and observability: `health`, `backend_log`, `otel_inspect`,
  `skill_tool_analytics`, `provider_models`, and `scheduler`.
- Prompt/compaction behavior: `inspect_prompt`, `compaction_cache`,
  `summarization_sse`, `summarization_improvements_test`, and `skill_dedupe`.
- Tool/LSP/media paths: `patch_tool`, `shell_output_delta`, `lsp_smoketest`,
  attachment scripts, image/video smoke tests, and result-offload checks.
- Provider transport probes: `try_providers/`; use each module's `--help` for
  model, streaming, tool, and authentication options.

Representative commands:

```bash
uv run python -m manual.health
uv run python -m manual.team_sse "message" --session <ID>
uv run python -m manual.backend_log --contains <event>
uv run python -m manual.otel_inspect --session <ID>
uv run python -m manual.lsp_smoketest --direct
make prompt-budget
```

## Adding or changing scripts

- Reuse `manual/_common.py` for shared base-URL/session helpers.
- Keep scripts import-safe, expose argparse `--help`, fail non-zero on violated
  assertions, and make mutating/external behavior explicit in help text.
- Prefer deterministic pytest or `tests/manual/` coverage for regressions;
  keep this subtree for live integration/diagnostic paths.
- Run the module's `--help` plus the smallest safe focused scenario. Document
  any server, credential, platform, or provider limitation in the result.
