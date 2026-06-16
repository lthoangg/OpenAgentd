# OpenAgentd Desktop (Tauri v2)

Native desktop shell for OpenAgentd. Embeds the React Web UI, can spawn the Python backend as a sidecar or connect to an external server, and ships an auto-update + signing pipeline.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenAgentd.app  (Tauri Rust)                           │
│  ┌────────────────────────┐  ┌──────────────────────┐   │
│  │  WebView (system)      │  │  Sidecar supervisor  │   │
│  │  bundled web/dist      │  │  python ... serve    │   │
│  │  injects API base URL  │──┤  --handshake         │   │
│  └────────────────────────┘  │  --generate-token    │   │
│                              │  --parent-pid <pid>  │   │
│                              └──────────┬───────────┘   │
└─────────────────────────────────────────┼───────────────┘
                                          │
                              ┌───────────▼─────────────┐
                              │  python-build-standalone │
                              │  + site-packages         │
                              │  + app/ (FastAPI)        │
                              │  API server only          │
                              └──────────────────────────┘
```

The Python sidecar:

1. Binds 127.0.0.1 on an OS-ephemeral port.
2. Generates a random URL-safe token.
3. Emits one JSON line on stdout: `OPENAGENTD_HANDSHAKE {"port":..., "token":..., "pid":...}`.
4. Then proceeds to start uvicorn normally.
5. Watches the Tauri PID; exits if the shell crashes.

The Tauri shell:

1. Checks the remembered external backend from `desktop-backend.json`; if it is healthy, opens the main WebView against that server.
2. If the remembered external backend is unreachable, continues startup with the bundled sidecar so the app remains usable.
3. Otherwise locates the bundled Python runtime in `Contents/Resources/python/` (macOS),
   `resources\python\` (Windows), or `usr/lib/openagentd/python/` (Linux).
4. Spawns the sidecar with `--handshake --generate-token --parent-pid <our pid>`.
5. Reads stdout until the handshake line; extracts `{port, token}`.
6. Polls `http://127.0.0.1:<port>/api/health/live` until it returns 200.
7. Installs an `initialization_script` that sets `window.__OAD_TOKEN__ = "..."`.
8. Opens one or more WebViews against the same sidecar/token (`Cmd/Ctrl+N` for a secondary window).
9. On app quit: SIGTERM the sidecar; force-kill after 5s.

## Development

```sh
# Once: install Rust + Tauri CLI
rustup default stable
cargo install tauri-cli --version "^2.0" --locked

# Build the web UI first
cd web && bun install && bun run build && cd ..

# Build a slim Python sidecar bundle (uses uv + python-build-standalone)
make -C desktop sidecar

# Run the desktop shell in dev mode (prefer ``make dev`` from this
# directory so the dev override picks up — see ``Makefile``).
cd desktop && make dev
```

## Packaging

See [`../documents/docs/desktop.md`](../documents/docs/desktop.md) for the
full release pipeline (matrix builds, signing, notarization, updater).
