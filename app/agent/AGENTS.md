# Agent Runtime Guide

This subtree owns agent loading, turn execution, providers, tools, teams, MCP,
permissions, prompts, and runtime wire schemas.

## Map and boundaries

- `loader.py` validates agent Markdown/frontmatter and materializes built-ins;
  `drift.py` detects user config changes and `builtin_prompts.py` owns
  first-party defaults.
- `agent_loop/` owns turns, streaming, retries, tool dispatch, and tool-result
  handling.
- `providers/` adapts provider-specific transports. Keep their payload quirks
  behind generic schemas in `schemas/`.
- `tools/` owns the registry and built-ins; preserve permission, sandbox,
  cancellation, output, and UI-result contracts when adding a tool.
- `mcp/` owns external MCP configuration and process/client lifecycle.
- `mode/team/` owns the session runtime, delegation tools (`agent_spawn`, `agent_send`,
  `agent_list`, `agent_stop`, `agent_merge`), async report delivery, and questions.
  Cross-surface team changes also involve
  `app/services/team_manager.py`, API routes, and frontend SSE stores.
  One `SessionRuntime` (`mode/team/runtime.py`) owns a session's agent, inbox,
  turn execution, commands, and stream lifecycle — there is no separate team or
  lead object, and `mailbox.py` holds only the `Message` payload. The `team`
  path segment is historical; see
  `documents/adrs/0002-single-session-runtime.md` for the boundaries this
  collapse relies on and the renames deliberately left undone.
- `plugins/` loads user plugin context; keep failures isolated from the core
  runtime.

First-party profile frontmatter is additive over code-owned defaults. Keep
prompt text capability-neutral because injected tools differ by runtime mode.
The plain builtin in `tools/builtin/todo.py` owns task tracking.

## Security and compatibility

- Review shell/file built-ins, denied-path handling, MCP launch arguments, and
  any model-supplied input together with their permission/sandbox tests.
- Use argument-list subprocess APIs; do not add `shell=True` construction.
- Streaming loops must turn provider/tool chunk failures into the established
  recoverable event path where possible. Coordinate event-shape changes with
  `web/src/api/` and `web/src/stores/`.
- Preserve provider-neutral persisted replay data. Provider-specific reasoning
  or tool metadata must round-trip through existing generic message fields
  rather than leaking a raw transport shape into other providers.

## Checks

```bash
uv run pytest tests/agent -q
uv run ruff check app/agent tests/agent
uv run ty check app/
make verify-backend
```
