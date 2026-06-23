# Install

OpenAgentd is a desktop app that runs a team of AI agents on your machine. It's open source (Apache 2.0). Install it with one of:

## Desktop app (recommended)

A native double-click installer for users who don't want a terminal. The desktop build is a [Tauri 2](https://tauri.app) shell that embeds the React Web UI and launches a bundled Python API sidecar — no port to remember.

### macOS

The easiest path is the Homebrew cask:

```sh
brew install --cask lthoangg/tap/openagentd
```

The cask handles quarantine + ad-hoc signing automatically on every install and upgrade.

Or grab the latest installer from the [releases page](https://github.com/lthoangg/openagentd/releases/latest):

| Platform | Artefact | Size |
|---|---|---|
| macOS (Apple Silicon, 11+) | `OpenAgentd_*_aarch64.dmg` or `OpenAgentd_*.app.tar.gz` | ~180 MB |
| Linux (x64) | `OpenAgentd_*_amd64.AppImage` or `OpenAgentd_*_amd64.deb` | ~160 MB |

> **Windows desktop is not currently supported.** Builds were removed in
> v1.23.0; see [`features.md`](./features.md#11-distribution-and-updates). Windows
> users can run the CLI/server inside WSL2.

Mount the `.dmg`, then run the bundled installer:

```sh
hdiutil attach OpenAgentd_*_aarch64.dmg
cd /Volumes/OpenAgentd*
./install.sh               # ad-hoc signs the bundle and exits
./install.sh --install     # also copies to /Applications
```

On first launch, **right-click `OpenAgentd.app` → Open** (single-click won't work the first time — that's by design). If you skip `install.sh` and just drag-to-Applications, you'll hit the `"damaged"` error. Re-run `install.sh` against the installed bundle to fix it:

```sh
./install.sh /Applications/OpenAgentd.app --force
```

### Linux

```sh
chmod +x OpenAgentd_*_amd64.AppImage
./OpenAgentd_*_amd64.AppImage            # run directly
```

Or use the bundled `install.sh` for a launcher entry:

```sh
./install.sh --install                   # copies to ~/.local/bin, drops a .desktop file
```

The `.deb` package works on Debian/Ubuntu derivatives: `sudo dpkg -i OpenAgentd_*_amd64.deb`. AppImage is preferred — self-contained, no system-level changes, runs on any glibc 2.28+ distro.

### Why is it unsigned? <a id="desktop-unsigned"></a>

OpenAgentd ships **without** an Apple Developer ID signature. The certificate is a paid subscription ($99/yr) we've chosen not to buy yet. The binary is exactly what came out of CI — reproducible from the [`release-desktop.yml`](https://github.com/lthoangg/openagentd/blob/main/.github/workflows/release-desktop.yml) workflow on a public GitHub-hosted runner — but macOS treats it the same as any unsigned executable.

That means:

- **macOS:** Gatekeeper rejects the bundle on first launch with `"OpenAgentd.app" is damaged and can't be opened`. The bundled `install.sh` works around this by stripping the quarantine xattr and ad-hoc signing the app *with your own machine as the signer*. This is the same workaround used by every open-source macOS app you compile yourself.
- **Linux:** No code-signing equivalent — the AppImage / .deb just runs.

The Tauri auto-updater is a separate signing chain. Update payloads are signed with a minisign key we control (public half embedded in the app, private half in GitHub secrets), so even though macOS thinks the app is unsigned, **updates themselves are cryptographically verified**.

### Update

Use **Settings → About → Updates** in the desktop app to check for releases. The updater silently checks every 6 hours. Native notification sounds are controlled by the operating system from the app's notification settings.

For Homebrew cask installs:

```sh
brew upgrade --cask openagentd
```

For CLI users:

```sh
openagentd upgrade
```

## pipx

```bash
pipx install openagentd
```

Same isolation model as `uv tool`, slower install. Use this if you already have pipx and don't want another tool.

## pip

```bash
pip install --user openagentd
```

Works on Linux distros and Python builds without [PEP 668](https://peps.python.org/pep-0668/) protection. On **macOS Homebrew Python**, **Debian/Ubuntu system Python**, and most modern distros, `pip install` will refuse with an `externally-managed-environment` error — use `uv tool install` or `pipx install` above instead, or create a venv first.

## CLI / API server

Use this if you already live in a terminal or want the server build:

```bash
uv tool install openagentd
pipx install openagentd
pip install --user openagentd
brew install lthoangg/tap/openagentd
curl -fsSL https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh   # zero-setup: bootstraps uv, then installs
```

The `lthoangg/tap/` prefix auto-taps the formula on first install — no separate `brew tap` step needed. Same isolation model as `uv tool`, slower install. On macOS Homebrew Python, Debian/Ubuntu system Python, and most modern distros, `pip install` may refuse with an `externally-managed-environment` error — use `uv tool install` or `pipx install` instead, or create a venv first.

```bash
openagentd init   # pick provider + API key, install default agents
openagentd        # http://localhost:4082
```

This starts the local API server on `http://localhost:4082`. The desktop app can connect through **Server connection**; when a server uses `--key`, the dialog verifies the access key before switching. The mobile app connects to the LAN URL printed by `openagentd start --lan --key`.

Useful server commands:

```bash
openagentd start --lan --key  # save LAN bind + access key, then print mobile/LAN URLs
openagentd address            # show local and LAN URLs
openagentd health             # check PID, port, API liveness/readiness, LAN mode
openagentd restart            # restart using settings.yaml server config
openagentd upgrade       # stop, upgrade, and restart if running
```

> **Note:** On first install or after a `brew reinstall`, you may see a warning about
> `Failed changing dylib ID` for the `cryptography` package. This is a cosmetic Homebrew
> relinking warning — openagentd still works correctly. Run `brew update` before
> reinstalling to ensure the latest formula is used.

## From source (development)

```bash
git clone https://github.com/lthoangg/openagentd.git
cd openagentd
cp .env.example .env              # add your API key(s)
uv sync                           # install Python deps
bun install --cwd web             # install frontend deps

make dev                              # backend (uvicorn :8000) + frontend (Vite :5173) with hot-reload
# API: http://localhost:8000   Web UI: http://localhost:5173
```

Requires [uv](https://docs.astral.sh/uv/) and [Bun](https://bun.sh).

## First run

### Desktop app

Open the app, then go to **Settings → Providers**. On first launch the sidecar creates the shared XDG workspace (`~/.config/openagentd`, cache/state/data/workspace roots, and `{OPENAGENTD_CONFIG_DIR}/plugins`) and installs the default editable agents, skills, and config files with a placeholder model. Packaged installs download those defaults from the GitHub release seed bundle. Add an API-key provider or click **Connect** for OAuth providers such as GitHub Copilot or OpenAI Codex to replace that placeholder with a working model.

Existing OpenAgentd CLI users do not need to uninstall or migrate before installing the desktop app. The desktop sidecar uses the same XDG config and data paths as the CLI; see [`../../MIGRATION.md`](../../MIGRATION.md) for details.

### CLI / server

Run the setup wizard once:

```bash
openagentd init
```

`init` asks for a provider, model, API key when needed, and installs the default agent team and editable config. Existing files are not overwritten. Missing built-in member blueprints are materialized from code when needed, and obsolete untouched first-party agent files from older installs may be removed; custom files are kept.

Config is written to `~/.config/openagentd/` (XDG standard). The desktop app and CLI share this same config directory. The database and logs go to `~/.local/share/openagentd/` and `~/.local/state/openagentd/`.

### Start the server

```bash
openagentd
```

The API server starts on http://localhost:4082. Database migrations run automatically. For mobile or another desktop on your LAN, use:

```bash
openagentd start --lan --key
openagentd address
openagentd health
```

### 3. First steps in the UI

- **Send a message** — the default lead agent (`openagentd`) is ready to chat. Start with something like "what can you do?" to explore its tools.
- **Switch agents** — click the agent name in the header to pick a different agent or spin up a team.
- **Workspace panel** — every file the agent reads, writes, or generates appears in the left panel. Click any file to preview or download it.
- **Command palette** — press `Ctrl+P` (or `Cmd+P` on macOS) to search sessions, agents, files, and actions.
- **Memory (Wiki)** — open the Wiki panel to view, edit, or delete anything the agent has remembered across sessions. The `USER.md` file at the top is always injected into every system prompt — edit it to give the agent standing context about you.

### 4. Customize your agent

Edit `~/.config/openagentd/agents/openagentd.md` to change the model, add tools/MCP, or rewrite the system prompt. Install skills under `~/.config/openagentd/skills/`; no agent-file edit is needed for normal skill discovery. The agent picks up agent-file changes at the end of the next turn — no restart needed.

See [Configuration](configuration.md) for the full reference.

---

Database migrations run automatically on startup in production mode.

## Project layout (from source)

```
openagentd/
├── app/                    # FastAPI backend
│   ├── agent/              # Agent loop, hooks, providers, tools, teams
│   ├── api/                # Routes (thin — logic in services/)
│   ├── core/               # Config, DB, middleware, logging
│   ├── models/             # SQLModel DB schemas (chat)
│   └── services/           # Business logic, stream store, memory, dream
├── web/                    # React 19 frontend (Vite + Bun)
├── tests/                  # pytest test suite
├── seed/                   # Default agents and empty mcp.json copied on first init
└── documents/              # All documentation
```

## Next

- [CLI reference](cli.md) — every `openagentd` subcommand
- [Configuration](configuration.md) — env vars, agent YAML, providers, sandbox
- [Troubleshooting](troubleshooting.md) — common install/runtime issues
