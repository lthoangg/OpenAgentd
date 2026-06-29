---
name: self-healing
description: >-
  Update or upgrade the agent's own configuration on request — swap the model,
  add tools or MCP servers, change the image-generation provider/model, or
  install a new skill. Use when the user says things like "upgrade yourself",
  "switch your model to X", "use Gemini for images", "make yourself faster/smarter".
---

# Self-Healing Skill

Modifies on-disk agent configuration in response to user requests. All changes are surgical edits under `{OPENAGENTD_CONFIG_DIR}/`. No code changes, no restarts.

## Modes — pick the right team first

| Mode | When active | Agent files |
|------|-------------|-------------|
| `normal` | default; no workspace attached | `{AGENTS_DIR}/*.md` |
| `coding` | coding workspace attached | `{AGENTS_DIR}/coding/*.md` |

Always edit the files for the mode you are currently running as. MCP servers and `multimodal.yaml` are global (shared by both modes).

The `normal` lead includes `generate_image` / `generate_video` by default; the `coding` lead does not.

## Scope

| Target | File | Example request |
|--------|------|-----------------|
| Model / params | Agent `.md` frontmatter | "switch to gpt-5" |
| Tools | Agent `.md` → `tools:` | "give yourself shell access" |
| MCP servers | Agent `.md` → `mcp:` or `tools:` | "let yourself use the filesystem MCP" |
| Image / video generation | `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml` | "use Gemini for images" |
| New skills | `{SKILLS_DIR}/{name}/SKILL.md` | use skill `skill-installer` |

## Workflow

1. **Identify the target file.** Ask "which agent?" only if ambiguous; default to the lead of the current mode.
2. **Read the current file.**
3. **Compute the minimal diff** — change only what was asked. Never reformat unrelated lines.
4. **Show a `diff` block** with a one-line summary.
5. **Wait for confirmation** unless the request was already explicit — then apply in the same turn after showing the diff.
6. **Apply with `edit`** (preserves the file verbatim). Use `write` only for new files.
7. **Report** what changed, which file, and when it takes effect.

## When changes take effect

| Change | Takes effect |
|--------|-------------|
| Agent `.md` | Next turn of that agent (drift detection) |
| `mcp.json` | After restarting the affected MCP server, on the next agent turn |
| `SKILL.md` edited | Next turn of any agent using the skill |
| New skill installed | Immediately loadable by `skill("name")` |
| `multimodal.yaml` | Instantly — read on every `generate_image` / `generate_video` call |

Process restart required only for: adding/removing agent files, `.env` changes, and code changes.

## Agent frontmatter — valid fields

| Field | Values |
|-------|--------|
| `model` | `provider:model` — e.g. `openai:gpt-4o`, `anthropic:claude-...`, `googlegenai:gemini-...` |
| `tools` | Extra tools on top of built-in profile: `web_search`, `web_fetch`, `date`, `read`, `write`, `edit`, `patch`, `ls`, `grep`, `glob`, `rm`, `shell`, `bg`, `generate_image`, `generate_video`, plus `<server>_<tool>` for MCP. Never add `skill` or `team_message` — injected automatically. |

**Invariants:** exactly one `role: lead` per agents dir; `model` must contain `:`.

## Recipes

### Find your own agent file
```bash
grep -l 'role: lead' {AGENTS_DIR}/*.md {AGENTS_DIR}/coding/*.md
```

### Setting up `multimodal.yaml`

When `generate_image` / `generate_video` returns "not configured", or the user explicitly asks.

1. Pick a provider (user-specified, or default to `openai:gpt-image-2` / `googlegenai:veo-3.1-generate-preview`).
2. Write immediately — don't check env vars first. If a key is missing the tool returns a clear error; relay it then.
3. Retry the original generation request after writing.

### MCP tools on agents

**`mcp:` list (recommended)** — grants all tools the server exposes:
```yaml
mcp:
  - filesystem
```

**`tools:` list (selective)** — pick specific tools:
```yaml
tools:
  - filesystem_read
```

Verify the server is ready before wiring:
```bash
curl -sS http://localhost:4082/api/mcp/servers/<name> | jq '{state, tool_names}'
```

When removing a server: strip it from agent `.md` files first, then edit `mcp.json` — otherwise the agent logs `agent_config_refresh_failed` on its next turn.

## Failure modes

- **File not found** → ask the user to confirm the path / agent name.
- **Malformed frontmatter** → show the problem; don't attempt repair unless asked.
- **Invariant violation** (two leads, unknown tool, unsupported provider) → explain and suggest the nearest valid alternative.
