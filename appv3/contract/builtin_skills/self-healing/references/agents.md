# Agents

| Agent | File |
|-------|------|
| Lead coding agent | `<AGENTS_DIR>/code.md` — must keep `name: code` |
| Member (delegate) agents | `<AGENTS_DIR>/<name>.md` with `role: member` — built-ins: `explorer`, `researcher` |

## Frontmatter fields

| Field | Values |
|-------|--------|
| `name` | Agent name. `code.md` must say `name: code`. |
| `role` | `lead` (default) or `member`. Only `code.md` is a lead; other files should be `member`. |
| `description` | One line shown to the lead when delegating. |
| `model` | `provider:model` — must contain `:`. Provider ids: `anthropic`, `openai`, `googlegenai`, `openrouter`, `vertexai`, `bedrock`, `copilot`, `codex`, `ollama`, `deepseek`, `xai`, `zai`, … plus provider plugins. The provider must already be configured. |
| `thinking_level` | `none`, `low`, `medium`, `high`; some models also accept `xhigh` / `max`. |
| `tools` | Extra tool names (see below). |
| `responses_api` | Legacy — parsed but not applied; don't add it. |

The Markdown body after the frontmatter is the system prompt. An empty body in
`code.md` means the built-in coding prompt — don't paste a prompt in unless asked.

**Model caveat:** `model` in `code.md` is the *default*. A model picked in the
composer for the current session takes precedence, so for the current chat also
tell the user to switch it in the model picker.

## Tools

- **`code.md`** always has `glob`, `grep`, `patch`, `read`, `shell`,
  `web_fetch`, `web_search`, plus the auto-injected `skill`, `todo_manage`,
  `schedule_task`, `send_to_workspace` and mode tools (`ask_user`, `plan`,
  `submit_plan`, `lsp`). Never list these. `send_to_workspace` (messaging
  sessions in other workspaces) is turned off globally with
  `workspace_messages: {enabled: false}` in `settings.yaml` (Settings →
  Automation), not through `tools:`. `tools:` adds extras — today `generate_image` and
  `generate_video`.
- **Members:** `tools:` is the allowlist, limited to `read`, `glob`, `grep`,
  `patch`, `shell`, `web_search`, `web_fetch`.
- MCP tools are not listed here — see `mcp.md`.
- Unknown tool names are removed from the file automatically on the next load —
  don't guess names.

## Example

```diff
 ---
 name: code
 role: lead
-model: openai:gpt-5
+model: anthropic:claude-sonnet-4-6
+thinking_level: high
+tools:
+- generate_image
 ---
```

## When changes take effect

| Change | Takes effect |
|--------|-------------|
| `code.md` edited | Next turn. An invalid edit keeps the previous config and logs `agent_config_refresh_failed`. |
| Member file added or edited | Next `delegate` call — no restart. |
| `code.md` deleted | Recreated with defaults on the next startup. |

## Failure modes

- **Model without `:`** → invalid; suggest `provider:model`.
- **Provider not configured** → the next turn reports "not configured"; offer to
  revert, or point the user to Settings → Providers.
