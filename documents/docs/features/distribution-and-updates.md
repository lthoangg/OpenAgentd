---
title: "Features: Distribution and updates"
description: "Installers, the CLI, release channels, and how each surface updates."
---

# Distribution and updates

Part of the [feature catalogue](../features.md), under *11. Distribution and updates*. The index explains the version tags.

Desktop is primary. CLI / server is the developer path.

- **The Seal logo** `[v3.22.0]` — the app, its icons, and the browser tab
  show the new OpenAgentd logo instead of the Octobot mascot: an ink disc
  with an open A and a Signal Blue dot (the agent). The macOS menu bar shows
  the A and the dot as a template icon, and loading screens pulse the dot
  (still with reduced motion).
- **macOS desktop** `[since v1.0]` — Homebrew cask
  (`brew install --cask lthoangg/tap/openagentd`) or `.dmg` with bundled
  `install.sh`. Until v3.21.0, installs and cask upgrades
  signed with your Apple Development identity if you have one, else an
  "OpenAgentd Local Signer" identity kept in its own keychain
  (`openagentd-signing.keychain-db`), so signing never asks for a password
  `[v3.4.0]`. Earlier builds kept that identity in the login keychain, where
  codesign asked to use its key on every install or update.
  If codesign cannot use the identity ("no identity found"), the install or
  update signs ad hoc instead of failing `[v3.6.0]`; v3.4.0–v3.5.0 in-app
  updates stopped there, so those installs update with `install.sh` or
  `brew upgrade --cask`.
  Since v3.22.0 nothing on your machine signs the app: CI signs it once
  (ad hoc, with a requirement that stays the same across releases, so
  folder-access grants survive updates), the DMG and the updater archive
  carry that same app, and `install.sh` and the cask only remove the
  download quarantine flag. In-app updates install the archive exactly as
  published, check its signature before stopping the backend, log a failed
  install and keep the running version working.
  Since v3.49.0 the app, the DMG and the updater archive are signed with
  the OpenAgentd Developer ID and notarized by Apple, so a downloaded DMG
  opens without the "damaged" dialog or any Terminal step, and `install.sh`
  and the cask no longer touch the quarantine flag. The first update to
  v3.49.0 asks once more for folder access (the signature changed); later
  updates keep it.
- **Linux desktop** `[since v1.0]` — a `.deb` for Debian/Ubuntu on x86_64.
  The AppImage has not been built since v1.0.4, and its settings and
  release steps are gone `[v3.54.0]`.
- **Windows desktop** `[v1.106.0]` — native x64 `.msi` installer with the
  bundled Python sidecar, WebView2 shell, Job Object process cleanup, native
  PowerShell/cmd shell execution, and signed in-app updates. Interactive PTY
  terminal tabs were unavailable until v3.0.0, which bundles the native backend
  and opens terminals through ConPTY. Quitting the app on Windows ends the
  built-in server at once: Windows has no equivalent of the stop signal that
  lets the server finish its requests first on macOS and Linux.
- **Windows one-command install** `[v1.107.0]` — the `install.ps1` PowerShell
  installer resolves the latest GitHub release, downloads its x64 MSI, rejects
  a non-MSI download before elevation, and invokes Windows Installer.
- **Signed update manifests** `[v1.2.2+]` — minisign-signed `latest.json` at the
  rolling `latest-desktop` release; verified before install.
- **In-app updater** `[v1.22.0]` — see [§1](#1-the-desktop-coding-workspace).
- **CLI install** `[since v1.0, native since v3.0.0]` — `install.sh --cli` (macOS / Linux),
  `install.ps1 -Cli` (Windows), or `brew install lthoangg/tap/openagentd` installs the
  native standalone executable into `~/.local/bin` (or `%LOCALAPPDATA%\OpenAgentd\bin`)
  and cleans up any existing Python v2 uv/pipx install. The Python package managers
  (`uv tool`, `pipx`, `pip`) were used through v2 and are sunset in v2.27.0.
  Prebuilt CLI archives cover Apple Silicon macOS, x86_64 Linux and x86_64 Windows;
  releases after v3.6.0 no longer ship Intel macOS or ARM Linux archives, and
  `install.sh` says so on those machines.
- **v2 end-of-life notice** `[v2.27.0]` — the last Python release. Interactive
  CLI commands and `openagentd upgrade` say that v2 gets no further updates and
  print the v3 install command plus the step that removes the uv/pipx/pip copy.
  The desktop sidecar never shows it.
- **CLI renamed to `agentd`** `[v3.18.0]` — the command is now `agentd`
  (`agentd server start`, `agentd auth codex`, …), and the desktop app's
  bundled backend is `agentd` too. Releases still ship `openagentd`
  *(deprecated)* as a small alias that forwards to `agentd` and, on a terminal,
  says the old name will be removed. Existing installs keep working and
  `openagentd upgrade` from older releases updates to both. Release archive
  names, the Homebrew formula, config and data directories, and
  `OPENAGENTD_*` variables are unchanged.
- **Concise native CLI** `[v3.1.0]` — `agentd --help` lists eight command
  groups with short examples, errors print as one `error: …` line, and usage
  errors exit 2. Bare `agentd` prints help instead of starting the server
  (use `agentd server start`); the name is kept for a future terminal UI.
- **CLI server control** `[v1.41.0, v2.4.0, v3.1.0]` — `agentd server start|stop|restart`,
  `agentd server status`, `agentd server logs`, and `agentd server
  start --host 0.0.0.0 --key` make the CLI the control plane for desktop/mobile backends.
  Since v3.1.0 `server status` also runs the port, live, ready, and LAN checks
  (the former `server health`, still accepted) and exits 1 when the server is
  stopped or unhealthy, and `server logs` shows readable log lines instead of
  raw JSON records.
- **CLI LAN mode and connect QR code** `[v3.18.0]` — `agentd server start
  --public` is shorthand for `--host 0.0.0.0` (it still needs an access key,
  e.g. `--key`). `--qr` on `server start`, `server restart`, and
  `server status` prints a QR code in the terminal with the LAN addresses and
  the access key: the same `openagentd://connect` link as the desktop
  **Show QR**, so scanning it with a phone opens the mobile app's **Backend
  connection** dialog with the address and key filled in. The code
  appears once the server is ready. It is skipped with a warning when the
  server is loopback-only, no LAN address is found, or the access key is
  unknown in that shell.
- **Foreground CLI agent execution** `[v2.4.0]` — `agentd run --prompt "..."`
  validates the current directory as a coding workspace, starts one persisted
  agent session, and streams only the agent's response text to standard
  output. `--model provider:model` and `--thinking` apply per-turn overrides;
  auto-approved tool permissions continue normally, while interactive agent
  questions stop the non-interactive command instead of leaving a suspended run.
  Since `[v3.1.0]`, `-C/--cd DIR` picks another workspace, `-c/--continue`
  continues the workspace's latest session, `--session ID` continues a given
  session, and `--json` prints every stream event as one JSON line.
- **CLI start --wait** `[v1.73.0, v2.4.0]` — `agentd server start --wait`
  starts the background server and polls `/api/health/ready` until the database
  connection and the agent session are fully ready; since v3.1.0 it exits 1 when
  the server dies or is not ready within 30 seconds.
  Since `[v3.54.0]` `server start` always waits, so `--wait` is accepted and
  changes nothing. It refuses a port that is already in use ("port 8000 is
  already in use") instead of reporting a start, shows the end of the log when
  the server dies, and prints **Stop** and the QR code only once the server
  answers.
- **CLI upgrade** `[v1.41.0, self-update v3.0.0]` — `agentd upgrade` in v3 stops the
  background server, downloads the latest prebuilt release archive from GitHub, verifies
  its SHA-256 checksum, swaps the binaries in place, and restarts the server if it was
  running. Homebrew installations delegate to `brew upgrade`. In v2.27.0, `openagentd upgrade`
  migrates existing uv/pipx/pip installations to the v3 native binary. `agentd update`
  is an alias `[v3.1.0]`.
- **CLI output** `[v3.51.0]` — every command prints in one style: a title
  line, sections, aligned columns, ✓/⚠/✗ marks, warnings that wrap, and a
  dim next step; piped output is the same text without colour. The top-level
  help groups the commands (Server, Agents, Setup, Maintenance), and errors
  can carry a `hint:` line. `agentd run "prompt"` takes the prompt as an
  argument (`--prompt` still works) and ends with the session id and how to
  continue it. `agentd doctor` groups its checks (Config, Providers, Server,
  Modules), folds the module list to one line when every module runs, and
  says when a newer release is out. `agentd lsp status` is a ✓/✗ table with
  the install command for each missing server; `agentd cleanup` totals what
  it would delete by kind and lists the largest folders by short id;
  `agentd server logs` shortens each record on a terminal; `agentd upgrade`
  reports each step and links the release notes.
- **CLI OAuth login status** `[v3.1.0]` — `agentd auth list` shows which
  OAuth providers (Codex, GitHub Copilot, Grok) are logged in, and
  `agentd auth logout <provider>` deletes the saved login.
  `agentd auth <provider>` still logs in.
  `agentd auth <provider> --add` signs in another account and
  `--account <name|id>` reconnects one; `agentd auth logout <provider>
  --account <name|id>` removes only that account. `agentd credentials list`
  shows stored keys and accounts without their values, and `agentd credentials
  import <dotenv>` copies provider keys from a dotenv file such as a project's
  `.env` `[v3.30.0]`.
- **CLI doctor** `[since v0.1.0, v3.1.0]` — `agentd doctor` checks provider credentials
  (including keys saved in Settings → Models and the lead agent's OAuth
  login), the database, the configured server port, and the agents directory,
  and exits 1 when a check fails. With the server running it also lists the
  server's modules and their state, with the reason a module failed or is
  blocked `[v3.44.0]`.
- **CLI plugin management** `[v3.44.0]` — `agentd plugin add <git URL or
  folder>` shows what a plugin adds (skills, each MCP server's exact command
  or URL, permissions, tools) and asks before installing; without a terminal
  it prints that summary and exits with status 2 unless `--yes` is given. Git
  URLs must be `https://`, `ssh://`, `user@host:path` or `file://`, and
  `--path` picks a subfolder. A running server loads the plugin at once.
  `agentd plugin check <folder>` validates a plugin without installing it,
  `agentd plugin list` shows each plugin and its state, and
  `agentd plugin remove <name>` deletes it and keeps its data.
  `agentd plugin disable <name>` turns a plugin off without removing it and
  `agentd plugin enable <name>` turns it back on; a running server applies
  either at once, as it does a hand edit of `plugins.json` `[v3.45.0]`.
- **CLI artifact cleanup** `[v2.18.0]` — `agentd cleanup` previews a dry run
  and, with `--apply`, deletes sessions older than `--older-than-days`
  (default 14) together with their messages, session artifacts, undo/redo
  snapshot repos, and app-managed telemetry, logging, and worktree state that
  no live session owns. `--vacuum` then rebuilds the SQLite file so pages freed
  by the deleted rows return to disk; a lock held by a running server is
  reported rather than failing the pass. Since v3.1.0 the preview lists the
  largest candidates with their size and reason (`--limit N`, `0` for all).
- **Server migration export/import** `[v1.97.0, v2.4.0]` — `agentd transfer export` packs
  agents, skills, commands, plugins, and config files into a timestamped
  `.tar.gz` archive. `agentd transfer import <archive>` unpacks it on the target
  machine with fill-in-gaps merge (or `--force` to overwrite). API keys in
  `.env` are redacted by default; `--include-secrets` opts in for trusted
  channels. `credentials.yaml` is left out unless `--include-secrets` is
  passed and is written owner-only on import; an older archive's `.env` keys
  are moved into the store on import `[v3.30.0]`. Imports resolve every destination inside the config root and reject
  traversal through pre-existing symlinks `[v1.103.0]`. DB and session
  workspaces are intentionally excluded.
- **Cross-platform single-instance** `[v1.13.0]` — opening the app twice
  focuses the existing window instead of launching a duplicate.
- **Desktop force reload respects backend mode** `[v1.68.0]` — external-server
  windows now do a frontend-only force reload without restarting the bundled
  sidecar, while bundled windows wait for backend readiness before the desktop
  UI finishes bootstrapping after reload.
- **Reload preserves the current open page** `[v2.9.0]` — reloading in browser
  or desktop shells (Cmd+R / Ctrl+R) restores the active session, scheduler, or
  telemetry view instead of returning to the home workspace. Desktop Reload
  (View menu, tray, and palette Reload Window) reopens the exact session: the
  window's first-load route hint is ignored on a reload `[v3.14.0]`.
- **Closest restorable route fallback after backend switches** `[v1.68.0]` —
  when reconnecting to a backend that does not have the previous
  coding session, desktop restore now lands on the nearest valid hub page
  instead of reopening a stale session-specific route.
