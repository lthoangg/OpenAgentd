---
title: Paths & XDG Roots
description: Six XDG-aligned roots, development vs production layout, on-disk file map.
status: stable
updated: 2026-06-28
---

# Paths & XDG Roots

**Sources:** `app/core/config.py`, `app/core/paths.py`

OpenAgentd splits runtime files across **six** XDG-aligned roots, one per category of data. Each is overridable via an environment variable; all six are derived automatically from `APP_ENV` when unset.

In a source checkout, `APP_ENV` now defaults to `development`, so plain `uv run ...` commands land under `.openagentd/dev/` unless you override them. Installed / CLI-managed server entry points still force `production`.

## Roots

| Root | Env var | Production default | Development default | Sandbox |
|------|---------|--------------------|---------------------|---------|
| Data | `OPENAGENTD_DATA_DIR` | `~/.local/share/openagentd` | `.openagentd/dev/data` | denied |
| Config | `OPENAGENTD_CONFIG_DIR` | `~/.config/openagentd` | `.openagentd/dev/config` | allowed |
| State | `OPENAGENTD_STATE_DIR` | `~/.local/state/openagentd` | `.openagentd/dev/state` | denied |
| Cache | `OPENAGENTD_CACHE_DIR` | `~/.cache/openagentd` | `.openagentd/dev/cache` | denied |
| Workspace | `OPENAGENTD_WORKSPACE_DIR` | `~/.local/share/openagentd-workspace` | `.openagentd/dev/workspace` | allowed |

**What lives where:**

- **Data** — irreplaceable user data. SQLite DB (`openagentd.db`) and session artifacts (`sessions/{id}/`). **Back this up.**
- **Config** — hand-edited configuration. Agents (`agents/`), skills (`skills/`), runtime settings (`settings.yaml`), generation config (`multimodal.yaml`), MCP (`mcp.json`), sandbox (`sandbox.yaml`), `.env`. (Summarisation has no file-based config — all tuning lives in `app/agent/hooks/summarization.py`.)
- **State** — historical bookkeeping. Logs (`logs/`), telemetry (`telemetry/`), OTEL rollups (`otel/`), `openagentd.pid`. Safe to archive.
- **Cache** — regeneratable throwaway. `quoteoftheday.json`, `copilot_oauth.json`, `codex_oauth.json`. Safe to delete any time.
- **Workspace** — per-session agent workspaces (`{root}/<sid>/`). Normal-mode uploads live at `{root}/<sid>/uploads/`; coding-mode uploads live at `<coding-workspace>/uploads/`. Allowed by the sandbox so filesystem tools (`read`/`write`/`shell`) can operate there.

## `.env` location

Two `.env` files are loaded if present — the home-config file takes priority over the project one:

| Mode | `.env` location |
|------|-----------------|
| Production | `~/.config/openagentd/.env` |
| Development | `.env` (project root) |

## Full directory layout

Dev-mode paths shown below — substitute the production columns from the table above:

```
.openagentd/
├── dev/                                   # local development runtime state
│   ├── data/                              # OPENAGENTD_DATA_DIR
│   │   ├── openagentd.db                  # main SQLite DB
│   │   └── sessions/{session_id}/         # session runtime artifacts
│   │       ├── .todos.json                # todo_manage store
│   │       └── .tool_results/
│   │           ├── shell/*.txt            # large shell output spills
│   │           └── {agent}/*.txt          # large tool-result offloads
│   ├── workspace/                         # OPENAGENTD_WORKSPACE_DIR
│   │   └── {lead_session_id}/             # normal-mode workspace
│   │       └── uploads/<filename>         # user uploads (deduped original names; reachable as `uploads/<filename>`)
│   ├── config/                            # OPENAGENTD_CONFIG_DIR
│   │   ├── .env                           # secrets (gitignored)
│   │   ├── agents/*.md                    # per-agent config
│   │   ├── agents/coding/*.md             # coding-mode team
│   │   ├── skills/{name}/SKILL.md         # skills
│   │   ├── settings.yaml                  # Dream + title generation runtime settings
│   │   ├── multimodal.yaml                # image/video gen config
│   │   ├── mcp.json                       # MCP server config
│   │   ├── sandbox.yaml                   # user-defined deny patterns
│   │   └── plugins/                       # user plugin .py drop-ins (OPENAGENTD_PLUGINS_DIRS)
│   ├── state/                             # OPENAGENTD_STATE_DIR
│   │   ├── logs/
│   │   │   ├── app/app.log                # JSON app log (DEBUG+, 10 MB / 7 days)
│   │   │   ├── app/app-error.log          # JSON error log (ERROR+, 10 MB / 14 days)
│   │   │   └── sessions/{session_id}/
│   │   │       ├── session.log            # human-readable per-session sink
│   │   │       └── {agent}.jsonl          # structured events (SessionLogHook)
│   │   ├── telemetry/{session_id}/{user_msg_id}.jsonl  # context window snapshots
│   │   ├── snapshot/{session_id}/         # out-of-tree git repo for /undo + /redo
│   │   ├── otel/                          # OTEL spans + metrics
│   │   └── openagentd.pid                 # server PID file
│   └── cache/                             # OPENAGENTD_CACHE_DIR
│       ├── quoteoftheday.json             # Quote of the Day cache
│       ├── copilot_oauth.json             # GitHub Copilot token
│       └── codex_oauth.json               # OpenAI Codex OAuth token
├── commands/                              # project slash commands
└── skills/                                # project skills
```

## Session path helpers (`app/core/paths.py`)

Backend code never constructs session paths inline. Two pure helpers return the canonical `Path` objects:

| Helper | Path | Ownership |
|--------|------|-----------|
| `workspace_dir(sid)` | `{OPENAGENTD_WORKSPACE_DIR}/{sid}` | Agent workspace root. File bytes served at `GET /api/team/{sid}/media/{path}`; flat recursive listing at `GET /api/team/{sid}/files`. |
| `uploads_dir(sid)` | `{workspace_dir(sid)}/uploads` | Normal-mode user uploads (flat, sanitized original names with ` (n)` dedupe suffixes when needed). Served at `GET /api/team/{sid}/uploads/{filename}`. Lives **inside** the session workspace so filesystem tools can pass uploads to workspace-bound tools as `uploads/<filename>`. |

Session-scoped agent artifacts are centralized in `app/agent/artifacts.py` and live below `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/`:

| Artifact | Path | Cleanup |
|----------|------|---------|
| Todos | `.todos.json` | Deleted with the session artifact directory. |
| Shell output spills | `.tool_results/shell/*.txt` | Deleted with the session artifact directory or cleanup. |
| Tool-result offloads | `.tool_results/{agent}/*.txt` | Deleted with the session artifact directory or cleanup. |

Coding sessions use the selected project directory as the sandbox workspace. Runtime artifacts still stay under the XDG roots, but file uploads now live under `<coding-workspace>/uploads/` so `read("uploads/<filename>")` resolves from the sandbox root exactly as hinted. The upload-serving endpoint resolves against that same session-aware storage root, so persisted previews still load after a page reload. `DELETE /api/team/sessions/{id}` purges normal session workspaces and the XDG session artifact directory; coding sessions keep the project directory.

## Generated artifact cleanup

`openagentd cleanup` performs a dry run by default:

```bash
openagentd cleanup                    # list artifacts older than 14 days
openagentd cleanup --older-than-days 7
openagentd cleanup --apply            # delete the listed artifacts
```

Cleanup targets generated, regeneratable artifacts only:

- orphaned normal session workspaces under `OPENAGENTD_WORKSPACE_DIR`;
- orphaned session artifact directories under `{OPENAGENTD_DATA_DIR}/sessions/`;
- old state logs, telemetry files, and OTEL files.

It intentionally does not delete `OPENAGENTD_DATA_DIR`, `OPENAGENTD_CONFIG_DIR`, or credential/cache files.
