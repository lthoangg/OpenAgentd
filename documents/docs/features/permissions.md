---
title: "Features: Path denylist and permissions"
description: "The trust model, blocked files, and what the agent may touch."
---

# Path denylist and permissions

Part of the [feature catalogue](../features.md), under *8. Path denylist and permissions*. The index explains the version tags.

Single-user trust model. The host is trusted. The operator is the user.

- **Path denylist** `[since v1.0]` — absolute paths anywhere on disk are accepted
  *unless* they resolve under a denied root (`OPENAGENTD_DATA_DIR`,
  `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) or match a user-defined glob
  in `denied_paths.yaml`. User-defined deny globs are enforced inside the active
  workspace too, not only outside it `[v1.74.0]`. Symlinks are rejected only
  when targeting a denied root. Tilde paths are always rejected.
- **Self-diagnostic carve-outs** `[v1.120.4]` — agents can read their own
  runtime diagnostics inside the denied state root: `{STATE_DIR}/logs`,
  `{STATE_DIR}/otel` (span/metric rollups), and `{STATE_DIR}/telemetry`
  (per-turn context-window dumps), plus the current session's own artifact dir.
  Credentials (`OPENAGENTD_CACHE_DIR`), the SQLite DB, undo/redo snapshots, and
  other sessions' artifacts stay denied. This is what makes the
  `oad/debug-prod` log/telemetry workflow usable without disabling the path denylist.
- **Shell command pre-scan** `[since v1.0]` — best-effort path-token scan
  inside shell commands.
- **Secret-free shell environment** `[v3.11.1]` — the agent's shell tool and
  the built-in terminal do not inherit secrets the server holds: its access
  token, provider API keys, and every other value it loaded from a `.env` file
  or saved from Settings (including MCP secrets). `printenv` cannot get around
  the `**/.env` read denial. Variables the user exported before starting the
  server still pass through, except the server's own `APP_ENV` and
  `OPENAGENTD_*` variables `[v3.32.0]`: a project reading `APP_ENV` no longer
  sees the app's `production`, and a development build started from the
  agent's shell no longer opens the installed app's database.
- **`credentials.yaml` secret store** `[v3.30.0]` — every saved API key, OAuth
  login, and MCP client secret lives in one versioned `credentials.yaml` in the
  config dir, written atomically under a file lock with owner-only (`0600`)
  permissions. The server no longer loads secrets into its process environment.
  On first start, keys from the config dir's `.env` and the old OAuth token
  files in the cache dir move into it; the originals are kept (`.env` as
  `.env.migrated`). Provider keys still in a `.env` afterwards are ignored, and
  `agentd doctor` warns about them. Non-secret settings in `.env` keep loading. A
  server reads only its config dir's `.env` `[v3.32.0]`: not the `.env` of the
  directory it starts in (a project's `DATABASE_URL` or `API_PORT` no longer
  reach it), not the installed app's file when it runs in development, and a
  `.env` cannot set the mode; the log and `agentd doctor` name skipped files. A
  malformed store is an error, never read as empty. Agent file tools and shell
  commands are denied the store, its lock, and the backup. It is plaintext, so
  shell tools running as the user could still read it outside those checks.
- **Production and development modes** `[v3.32.0]` — the build picks the mode:
  the installed app and `agentd` (release builds) run in production with the
  `~/.local/share/openagentd`-style dirs, and a source checkout's `cargo run`,
  `make run` and `make dev` (debug builds) run in development under
  `.openagentd/dev/`, whatever the shell they start from inherited.
  `OPENAGENTD_ENV=production|development` overrides it, and any other value
  stops `agentd` with an error. `APP_ENV` still works for this release when it
  is `production` or `development`, with a note to rename it; other values
  (another program's `APP_ENV=local`) are ignored instead of moving the data
  into the current directory.
  The server's settings variables moved to the `OPENAGENTD_` prefix too
  (`OPENAGENTD_PORT`, `OPENAGENTD_DATABASE_URL`, `OPENAGENTD_LOG_LEVEL`,
  `OPENAGENTD_CORS_ORIGINS`, …), so a project's `API_PORT` or `DATABASE_URL`
  is never read as the app's. The old names still work for this release, and
  the log and `agentd doctor` name the new one. Standard names of other tools
  keep theirs (`OTEL_EXPORTER_OTLP_ENDPOINT`, `RUST_LOG`, provider keys).
- **`.env` replaced by `server.yaml`** `[v3.32.0]` — the CORS origins, the LAN
  opt-out and both log levels live in the config dir's `server.yaml`
  (`cors_origins`, `allow_insecure_lan`, `log_level`, `file_log_level`) beside
  the host, port and access key; the environment still overrides them. On
  first start they move there from the config dir's `.env`, which is kept as
  `.env.v3.32.bak` (denied to agent tools like `.env.migrated`). The `.env` is
  *(deprecated)*: what is left in it still loads in this release, and the log
  and `agentd doctor` name those keys so they can move to the environment.
