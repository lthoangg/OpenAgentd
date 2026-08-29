# Agent Runtime Guide

This subtree owns agent loading, turn execution, providers, tools, session runtime, MCP,
permissions, prompts, and runtime wire schemas.

## Map and boundaries

- `loader.py` validates agent Markdown/frontmatter and materializes built-ins;
  `drift.py` detects user config changes and `builtin_prompts.py` owns
  first-party defaults.
- `session.py` owns single-agent session runtime, turn execution, and question suspension.
- `agent_loop/` owns turns, streaming, retries, tool dispatch, and tool-result handling.
- `providers/` adapts provider-specific transports. Keep their payload quirks
  behind generic schemas in `schemas/`.
- `tools/` owns the registry and built-ins; preserve permission, sandbox,
  cancellation, output, and UI-result contracts when adding a tool.
- `mcp/` owns external MCP configuration and process/client lifecycle.
- `plugins/` loads user plugin context; keep failures isolated from the core
  runtime.

First-party profile frontmatter is additive over code-owned defaults. Keep
prompt text capability-neutral because injected tools differ by runtime mode.
The builtin in `tools/builtin/todo.py` manages the single-agent task list.

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
