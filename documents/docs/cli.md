# CLI reference

The `openagentd` binary is the single entry point for running, managing, and inspecting the server.

## Start

```bash
openagentd                            # start in the background
openagentd start --lan --key          # save LAN host + required client access key
openagentd restart                    # reuse server.yaml host/port/access_key
```

**Flags**

| Flag | Default | Description |
|---|---|---|
| `--host` | `server.yaml host` | Bind address and save it to `server.yaml` |
| `--port` | `server.yaml port` | API port and save it to `server.yaml` |
| `--lan` | off | Save/bind `0.0.0.0` and print LAN/mobile addresses; a configured access key is required |
| `--key` | off | Prompt for a LAN access key, save it to `server.yaml`, and require API clients to send `Authorization: Bearer <key>` |
| `--wait` | off | Wait/poll until the background server is fully started and ready |
| `--watch` | off | Alias for `--wait` |

The server runs as a detached background process and exposes the API on port 4082 by default. Non-loopback binds are refused unless a desktop token or access key is configured; use `--lan --key` for first-time LAN setup. Bind/auth overrides are validated before they are written to `server.yaml`, so a refused start does not leave persistent configuration drift. It does not serve the React Web UI; use the desktop app for the packaged UI or `make dev` from source for Vite + API development. Logs go to `~/.local/state/openagentd/logs/app/app.log`. The server auto-migrates the database on startup. For mobile clients on the same network, use `openagentd start --lan --key` in public or shared networks. `--lan`, `--host`, `--port`, and `--key` update `~/.config/openagentd/server.yaml`, so later `openagentd restart` and `openagentd upgrade` keep the same bind address, port, and access-key protection without another prompt. Older `settings.yaml` server blocks are migrated automatically. Agents, providers, sessions, and the rest of the runtime configuration remain shared with the desktop builtin sidecar; only the independently launched servers' bind/auth state is separated. The desktop/mobile/web backend connection dialog has an **Access key** field that stores the key locally and sends it on API/SSE requests.

If openagentd hasn't been initialised yet, `openagentd` automatically runs `openagentd init` before starting the server.

For local frontend + backend development with hot-reload, use `make dev` (from the source checkout): it starts uvicorn with `--reload` on `:8000` and Vite on `:5173` together. `make dev-lan` explicitly enables unauthenticated development access and exposes both servers on the LAN. Use it only on a trusted network; normal CLI and production LAN launches still require an access key.

---

## init

```bash
openagentd init           # interactive setup (~/.config/openagentd/)
```

Interactive first-time setup wizard. Prompts for provider, model, and API key, then installs the default agent team and editable config. Re-running `init` is safe — existing files are never overwritten.

See [Install — First run](install.md#first-run) for a full walkthrough.

---

## auth

```bash
openagentd auth copilot         # GitHub Copilot — device-flow OAuth
openagentd auth codex           # OpenAI Codex — PKCE OAuth (browser)
openagentd auth codex --device  # OpenAI Codex — headless device-code flow
openagentd auth --list          # list available OAuth providers
```

Authenticates with an OAuth-based provider. Only needed for providers that don't use an API key (GitHub Copilot, OpenAI Codex). Token is cached locally and reused on subsequent runs.

In the desktop/web UI, the same OAuth setup is available from **Settings → Providers**.

---

## migrate

```bash
openagentd migrate openclaw --model openai:gpt-5.5
openagentd migrate hermes --model openai:gpt-5.5
```

Imports OpenClaw or Hermes identity/context Markdown files into one OpenAgentd lead agent. Use `--from`, `--name`, `--config-dir`, and `--force` to override defaults.

See [`../../MIGRATION.md`](../../MIGRATION.md) for source files, output paths, and manual migration notes for Claude Code and Codex CLI.

---

## stop

```bash
openagentd stop
```

Sends `SIGTERM` to the background server process. Waits up to 5 seconds for a clean shutdown, then sends `SIGKILL` if needed. Clears the PID file.

---

## restart

```bash
openagentd restart
openagentd restart --host 127.0.0.1
openagentd restart --key
```

Stops the background server when it is running, then starts it again. `restart` reuses `server.yaml`; pass `--host`, `--port`, `--lan`, or `--key` to update that config before the server starts.

---

## status

```bash
openagentd status
```

Reports whether a background server is running, the PIDs, local/LAN addresses, and the log file path.

---

## address

```bash
openagentd address
openagentd address --lan
```

Prints the local server URL and detected LAN URLs for desktop/mobile pairing.

---

## health

```bash
openagentd health
openagentd health --lan
```

Runs server-focused diagnostics for desktop/mobile clients: PID state, port reachability, `/api/health/live`, `/api/health/ready`, and LAN binding guidance. Exits non-zero when required server checks fail.

---

## logs

```bash
openagentd logs           # tail last 50 lines and follow
openagentd logs -n 100    # tail last 100 lines and follow
```

Tails the server log file (equivalent to `tail -n <lines> -f`). Reads from `~/.local/state/openagentd/logs/app/app.log`. Errors are also written separately to `~/.local/state/openagentd/logs/app/app-error.log`.

---

## doctor

```bash
openagentd doctor
```

Runs a series of health checks and exits with code 1 if any fail:

| Check | Pass | Fail |
|---|---|---|
| Python version | ≥ 3.14 | < 3.14 |
| API key / OAuth | Any provider key set, or OAuth-only provider (`copilot`, `codex`, `vertexai`, `cliproxy`, `router9`, `ollama`) configured | No key and no OAuth provider found |
| Provider/key match | Lead agent's provider has a matching key (or is OAuth-only) | Provider set but key missing |
| Database | `openagentd.db` exists | Not found (warning only — created on first run) |
| Alembic config | `alembic.ini` next to `app/core/db.py` | Missing (reinstall) |
| Port 4082 | Available | In use |
| Agents directory | At least one `.md` in `{OPENAGENTD_CONFIG_DIR}/agents/` | Missing (run `openagentd init`) |

Warnings (degraded but bootable) don't affect the exit code. Run this first when something looks wrong.

---

## upgrade

```bash
openagentd upgrade
```

Stops the background server if it is running, upgrades openagentd to the latest published version, then restarts the server. Detects how openagentd was installed and delegates to the right package manager:

| Install method | Command run |
|---|---|
| Homebrew | `brew upgrade openagentd` |
| uv tool | `uv tool upgrade openagentd` |
| pipx | `pipx upgrade openagentd` |
| pip (fallback) | `pip install --upgrade openagentd` |

The desktop bundle has its own update path — **OpenAgentd → Check for Updates…** in the menu bar — backed by `tauri-plugin-updater` against a signed minisign manifest, not the PyPI flow above.

---

## version

```bash
openagentd version
openagentd --version
```

Prints the installed version and exits.

---

## Related

- [Install](install.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
