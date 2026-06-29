---
title: Agent Files
description: The .md frontmatter contract — fields, validation, editing workflows.
status: stable
updated: 2026-05-16
---

# Agent Files

**Sources:** `app/agent/loader.py` (`AgentConfig` schema), `app/agent/drift.py`

Each agent is a single `.md` file with **YAML frontmatter** (config) and a **Markdown body** (system prompt). No separate file needed.

## Locations

| Path | Purpose |
|------|---------|
| `{OPENAGENTD_CONFIG_DIR}/agents/*.md` | Normal-mode agents. Each directory loads as one team — exactly one file must have `role: lead`. |
| `{OPENAGENTD_CONFIG_DIR}/agents/coding/*.md` | Coding-mode team. Same rules — exactly one `role: lead`. |
| `{OPENAGENTD_CONFIG_DIR}/settings.yaml` | Runtime settings for title generation. See [`title-generation.md`](../title-generation.md). |
| `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml` | Image / video generation backends. |
| `{OPENAGENTD_CONFIG_DIR}/mcp.json` | MCP client config — see [`agent/tools.md`](../agent/tools.md#mcp-servers-appagentmcp). |

The Settings UI lists both normal and coding agents. Coding agents appear with names like `coding/openagentd`; their frontmatter `name:` remains the filename stem. Current first-party normal blueprints are `openagentd`, `explorer`, and `executor`; current first-party coding blueprints are `coding/openagentd`, `coding/coder`, and `coding/explorer`. Coding mode does not expose `executor`; stale `agents/coding/executor.md` files from older builds are hidden and pruned when still untouched. Seed install prunes obsolete untouched first-party files from older installs; custom files are kept.

## Example

```markdown
---
name: openagentd
role: lead                              # exactly one agent in the directory must be lead
description: Your on-machine AI assistant.
model: googlegenai:gemini-3.1-flash
temperature: 0.2
thinking_level: low
tools:
  - date
  - read
  - ls
  - shell
# skills: is optional explicit metadata; skill discovery does not require it.
# skills:
#   - my-skill
---

You are openagentd. Be concise and direct.
```

The Markdown body (everything after the closing `---`) is the system prompt. For built-in first-party profiles (`openagentd` and shipped members), the body is treated as extra prompt text appended to the code-owned base prompt; old seed prompt bodies are ignored to avoid duplication.

## Frontmatter fields

All from `AgentConfig` in `app/agent/loader.py`. Field types match the Pydantic model.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | No | `str` | Agent name. Defaults to the filename stem. |
| `role` | No | `Literal["lead", "member"]` | Default `member`. Exactly one file per team directory must be `lead`. |
| `description` | No | `str` | Short intro — surfaced on `GET /api/agents` and in teammates' system prompts. |
| `model` | Yes | `str` | `provider:model` string (see [`providers.md`](./providers.md)). |
| `tools` | No | `list[str]` | Extra built-in tool names (see [`tools.md`](./tools.md)). For first-party profiles, this list is additive on top of code-owned defaults. |
| `mcp` | No | `list[str]` | Extra MCP server names from `mcp.json`; the agent gets every tool that server exposes. For first-party profiles, this list is additive. |
| `skills` | No | `list[str]` | Optional explicit skill metadata/drift hooks (see [`skills.md`](./skills.md)). Normal skill discovery does not require this field. For first-party profiles, this list is additive. |
| `temperature` | No | `float` | Sampling temperature. |
| `thinking_level` | No | `str` | Extended-reasoning effort (e.g. `"none"`, `"low"`, `"medium"`, `"high"`). Valid values are model-specific — see [`providers.md`](./providers.md#thinking-thinking_level). |
| `responses_api` | No | `bool` | Force OpenAI Responses API on/off (overrides the auto-route from `thinking_level`). |

Summarisation has no per-agent overrides — see [`agent/summarization.md`](../agent/summarization.md). All tuning lives as constants in `app/agent/hooks/summarization.py`; the only per-session variation is the team mode (chat vs. coding), which selects the bundled prompt and keep window.

The `team_message` tool is **always injected** into team agents — do not list it. `todo_manage` is injected into the lead (and into members in team mode) — also do not list it manually.

## Validation

| Rule | Error |
|------|-------|
| No agent with `role: lead` | `No agent with 'role: lead' found` |
| More than one `role: lead` | `Multiple agents with 'role: lead' found` |
| `model` present without `:` separator | `invalid model '…' (expected 'provider:model')` |
| Tool name not in built-in registry | `unknown tool '…'` |
| Malformed or missing frontmatter | `missing YAML frontmatter` |

## Editing workflow

Two equivalent paths:

1. **Settings UI** (`http://localhost:4082/settings/agents`). Master-detail layout with searchable sidebar + hybrid form/raw editor. Saving valid input is live on the agent's **next turn** — no team reload, no in-flight turn disruption. Invalid input is rejected by both zod (client) and `AgentConfig` (server).
2. **Direct edit on disk** in any editor. Drift detection (`app/agent/drift.py`) reads file mtimes at end of every turn; the next turn rebuilds the agent from disk automatically.

**Adding or removing files** (team-shape change — new member, removed member) still requires a server restart. Renaming or deleting a member orphans their sessions; adding a new file is safe.

## Authoring rule

Keep prompt bodies **tool-agnostic**. Don't hardcode tool names like `` `shell` `` or `` `web_search` `` in the prompt body. Capabilities can change via config edits, and a prompt that names tools that no longer exist drives weak models to hallucinate. Describe intent ("prefer in-place edits over rewriting whole files") instead of tool names.

## Importing from other systems

Use the dedicated migration guide for setup-level migration from other agent harnesses: [`../../../MIGRATION.md`](../../../MIGRATION.md).

```bash
openagentd migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5
openagentd migrate hermes --from ~/.hermes --model openai:gpt-5
```

Writes one lead agent at `{OPENAGENTD_CONFIG_DIR}/agents/<name>.md`. Existing files are not replaced unless `--force` is passed.

- **OpenClaw** imports: `AGENTS.md`, `SOUL.md`, `SOULS.md`, `TOOLS.md`.
- **Hermes** imports: `SOUL.md`, `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`.
