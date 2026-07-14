---
title: Built-in Tools
description: Tools shipped with OpenAgentd — filesystem, shell, web, multimodal, scheduling, tasks, notes, team.
status: stable
updated: 2026-05-16
---

# Built-in Tools

**Source:** `app/agent/tools/builtin/`, `app/agent/tools/multimodalities/`

Tools below ship with OpenAgentd. List only the ones an agent should use under `tools:` in its `.md` frontmatter. Internal API and hook semantics live in [`agent/tools.md`](../agent/tools.md).

## Catalog

### Filesystem

Filesystem tools normally output workspace-relative paths. The `read` tool also accepts absolute paths for the active session's XDG artifact directory and `{OPENAGENTD_STATE_DIR}/logs/`, so agents can inspect offloaded tool results and logs. See [`sandbox.md`](./sandbox.md) for path-validation rules.

| Tool | What it does |
|------|--------------|
| `read` | Read a file (up to 5 MB; optional 1-indexed `offset` / `limit` pagination). Multimodal handlers in `filesystem/handlers.py` dispatch images, PDFs, and other documents. |
| `write` | Write or overwrite a file. |
| `edit` | Replace exact text in a file (fuzzy-matches whitespace / indentation). |
| `ls` | List directory contents. |
| `grep` | Regex content search across files; skips dotpaths, common generated directories, and root `.gitignore` matches. |
| `glob` | Glob pattern search. `match='path'` (default) for full-path patterns like `src/**/*.ts`; `match='name'` for filename-only like `*.py`. Skips dotpaths, common generated directories, and root `.gitignore` matches. |
| `rm` | Permanently delete a file or directory (`recursive=true` for non-empty dirs). |

> In **coding mode**, `write` / `edit` / `patch` results are augmented with
> real-time language-server diagnostics for the changed files — see
> [`lsp.md`](./lsp.md).

### Shell

| Tool | What it does |
|------|--------------|
| `shell` | Run a shell command inside the sandbox (60 s default timeout; supports `background=true` for long-running processes). |
| `bg` | Manage background processes for the active session: list, check status, read output, bounded wait, stop. |

### Web

| Tool | What it does |
|------|--------------|
| `web_search` | DDGS search with an Exa fallback when DDGS fails or returns no results. |
| `web_fetch` | Fetch a URL and return its content as Markdown. |

### Date / system

| Tool | What it does |
|------|--------------|
| `date` | Return today's date / time. |

### Multimodal generation

Both tools route through `multimodal.yaml` to choose a backend (Google, OpenAI, Codex). See [`agent/tools.md#multimodalyaml`](../agent/tools.md#multimodalyaml).

| Tool | What it does |
|------|--------------|
| `generate_image` | Generate (or edit) an image — text-to-image, image+text-to-image. |
| `generate_video` | Generate a video. |

## Always-injected tools

A few tools are injected by the framework — do **not** list them in `tools:`.

| Tool | Where injected |
|------|----------------|
| `skill` | Every agent. Loads a skill's instructions on demand. |
| `todo_manage` | Lead agents, plus team members in team mode (so members can claim assigned tasks). |
| `schedule_task` | Lead agents. Creates / manages scheduled task records. |
| `note` | Lead agents. (Also listable explicitly if a member needs it.) |
| `team_message` | All team agents. Peer-to-peer messaging. |
| `team_manage` | Lead agents in team mode. Roster operations. |

## MCP tools

Tools exposed by MCP servers configured in `{OPENAGENTD_CONFIG_DIR}/mcp.json` appear under each agent's `mcp:` frontmatter list (one entry per server name). The agent receives every tool that server exposes; there is no per-tool selection within a server. Settings can add, edit, delete, restart, and OAuth-connect MCP servers. Edits to `mcp.json` and live applies via `POST /api/mcp/apply` are hot-reloaded — see [`api/index.md`](../api/index.md#mcp-server-management).
