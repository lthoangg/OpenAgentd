# app/agent/ — Agent Instructions

Agent runtime: loops, providers, tools, teams, MCP, permissions, prompts, and runtime config loading.

## Where to look first

```
loader.py              Agent `.md` frontmatter schema and validation
drift.py               Hot-reload detection for edited agent files
builtin_prompts.py     Code-owned base prompts for first-party agents
agent_loop/            Core turn loop, tool execution, streaming, retries
providers/             LLM provider implementations and routing
schemas/               Chat/event/provider wire types
tools/                 Built-in tool registry and implementations
mcp/                   MCP config, manager, installer/runtime integration
mode/team/             Multi-agent teams, roster, mailbox, todo flow
plugins/               User plugin loading and role context
permission.py          Tool permission decisions
sandbox*.py            Shell/filesystem sandbox behavior
```

## Common feature checks

- Agent config/frontmatter change: update `loader.py`, seed agents if needed, and focused tests.
- Tool change: check `tools/registry.py`, the tool implementation, permission/sandbox behavior, and UI rendering if the result shape changes.
- Team behavior change: check `mode/team/`, `services/team_manager.py`, API routes, and SSE event consumers in `web/src/stores/`.
- Provider change: add/adjust tests under `tests/agent/providers/` and avoid leaking provider-specific shapes into generic schemas.

## Commands

```bash
uv run pytest --no-cov -q tests/agent
uv run ruff check app/agent tests/agent
uv run ty check app/
```

## Gotchas

- First-party profile frontmatter is additive on top of code-owned defaults.
- `team_message` and `todo_manage` are injected; do not ask users to list them manually.
- Keep prompt bodies tool-agnostic because runtime capabilities can change.
- Streaming loops must catch provider/tool chunk errors and emit recoverable events where possible.
- `SummarizationHook` respects `provider.support_interrupt`: when `False`, summarisation only fires at the user-turn boundary (last visible message is a real `HumanMessage` from the user), never mid-loop. `build_summarization_hook` in `member.py` reads this flag automatically.
- Codex/OpenAI Responses reasoning items are round-tripped via `AssistantMessage.reasoning_item_id`/`reasoning_encrypted_content` (persisted in `extra`, replayed ahead of the next `function_call`) — see `documents/adrs/0003-codex-reasoning-encrypted-content-replay.md`. This preserves reasoning continuity across turns; it does not guarantee the model emits human-readable reasoning detail text (a separate, server-side gap).
- Bedrock is Mantle-only: route only recognized Models.dev transport metadata through its Anthropic/OpenAI delegate, keep OpenAI `store: false`, and use bearer-token or AWS-profile auth — see `documents/adrs/0006-bedrock-mantle-only-routing.md`.
- Grok Build subscription access uses the separate `grok:` OAuth provider; keep direct `xai:` API-key behavior independent — see `documents/adrs/0007-separate-grok-build-oauth-provider.md`.
