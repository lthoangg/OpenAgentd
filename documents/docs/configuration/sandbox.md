---
title: Sandbox & Permissions
description: Denylist path validation, user deny-glob patterns, and the per-tool permission system.
status: stable
updated: 2026-06-26
---

# Sandbox & Permissions

**Sources:** `app/agent/sandbox.py`, `app/agent/sandbox_config.py`, `app/agent/permission.py`, `app/agent/tools/builtin/filesystem/`

Two complementary mechanisms protect the host:

1. **Sandbox** — path-validation denylist for filesystem tools.
2. **Permission system** — per-tool-call allow / deny / ask gating.

Both are documented in depth in [`agent/tools.md`](../agent/tools.md). This page covers the user-facing config surface.

## Sandbox model

The sandbox uses a **denylist** model — paths anywhere on disk are accepted unless they:

- Resolve under a denied root: `OPENAGENTD_DATA_DIR`, `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`.
  - Exception: `{OPENAGENTD_STATE_DIR}/logs/` is readable so agents can inspect OpenAgentd logs such as `app/app.log` and `app/app-error.log`.
  - Exception: the active session artifact directory is readable so agents can inspect offloaded tool results.
- Match a user-defined glob pattern from `sandbox.yaml` (including files inside the active workspace, such as `**/.env`).
- Are a tilde-prefixed path (`~/...`) — always rejected.
- Are a symlink whose target lands inside a denied root.

The `SandboxConfig` is active per-run via a `contextvars.ContextVar` (`get_sandbox()` / `set_sandbox()`). Team members install their own sandbox on activation and reset it on completion.

## User deny patterns (`sandbox.yaml`)

```yaml
# {OPENAGENTD_CONFIG_DIR}/sandbox.yaml
denied_patterns:
  - "**/.env"
  - "**/.env.*"
  - "**/secrets/**"
```

- Patterns are loaded each time a `SandboxConfig` is built, so saved changes take effect on the **next agent run** without a server restart.
- `**/.env` and `**/.env.*` are the seeded defaults — they come from `SandboxFileConfig`'s model default, so they apply both when the file is absent **and** when the file exists but omits `denied_patterns`.
- The file is only written when the user saves from the Settings UI.

**Edit via the UI** at `http://localhost:4082/settings/sandbox`, or directly via `PUT /api/settings/sandbox` (see [`api/index.md`](../api/index.md#settings)).

## Shell command scanning

`shell` does a **best-effort** path-token scan of the command string (`check_command()` in `app/agent/sandbox.py`) to refuse obvious attempts to read denied paths. This is not bulletproof — anything beyond simple `cat /path/to/.env` slip past intentionally. The denylist is the line of defence for filesystem tools; shell relies on the operator trusting the agent's prompts.

## Permission system

Independent of the sandbox. Every tool call goes through a `PermissionService`:

| Implementation | Behaviour |
|----------------|-----------|
| `AutoAllowPermissionService` | Default. Auto-allows every call. Emits `permission_asked` SSE events for observability but never blocks. |
| `PermissionService` | Blocks on an `asyncio.Future` until the user replies via `POST /api/team/{session_id}/permissions/{request_id}/reply` (`once` / `always` / `reject`). |

Rules use **wildcard matching with last-match-wins** evaluation (see `app/agent/permission.py:Rule` / `Ruleset`). Each concurrent tool call supplies its own event callback, so `permission_asked` events remain scoped to the originating session without replacing the service-level observer. The UI surface is `/settings/sandbox` (rules tab).
