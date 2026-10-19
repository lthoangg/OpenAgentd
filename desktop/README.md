# OpenAgentd Desktop (Tauri v2)

Native desktop shell for OpenAgentd. Embeds the React Web UI, can spawn the native `agentd` backend (built from `appv3/`) as a sidecar or connect to an external server, and ships an auto-update + signing pipeline.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenAgentd.app  (Tauri Rust)                           │
│  ┌────────────────────────┐  ┌──────────────────────┐   │
│  │  WebView (system)      │  │  Sidecar supervisor  │   │
│  │  bundled web/dist      │  │  agentd server       │   │
│  │  injects API base URL  │──┤  serve --handshake   │   │
│  └────────────────────────┘  │  --generate-token    │   │
│                              │  --parent-pid <pid>  │   │
│                              └──────────┬───────────┘   │
└─────────────────────────────────────────┼───────────────┘
                                          │
                              ┌───────────▼──────────────┐
                              │  sidecar/bin/agentd      │
                              │  one native binary       │
                              │  API server only         │
                              └──────────────────────────┘
```

The sidecar:

1. Binds 127.0.0.1 on an OS-ephemeral port.
2. Generates a random URL-safe token.
3. Emits one JSON line on stdout: `OPENAGENTD_HANDSHAKE {"port":..., "token":..., "pid":...}`.
4. Then serves the API normally.
5. Watches the Tauri PID; exits if the shell crashes.

The Tauri shell:

1. Opens the main WebView immediately with a loading/unreachable backend state.
2. Checks the remembered external backend from `desktop-backend.json`; if it is healthy, updates the WebView to use that server.
3. If the remembered external backend is unreachable, continues startup with the bundled sidecar so the app remains usable.
4. Otherwise locates the bundled backend: `sidecar/bin/agentd`
   (`agentd.exe` on Windows).
5. Spawns the sidecar with `--handshake --generate-token --parent-pid <our pid>`.
6. Reads stdout until the handshake line; extracts `{port, token}`.
7. Polls `http://127.0.0.1:<port>/api/health/live` until it returns 200.
8. Updates the already-open WebView with `window.__OAD_TOKEN__ = "..."` and the backend URL.
9. Opens secondary WebViews against the same sidecar/token (`Cmd/Ctrl+N`).
10. On app quit: SIGTERM the sidecar on POSIX; terminate it immediately on
    Windows, with the Job Object as crash-cleanup backstop.

## Development

```sh
# Once: install Rust + Tauri CLI
rustup default stable
cargo install tauri-cli --version "^2.0" --locked

# Build the web UI first
cd web && bun install && bun run build && cd ..

# Build the backend sidecar (fat-LTO `dist` profile; PROFILE=release is faster)
make -C desktop sidecar

# Run the desktop shell in dev mode (prefer ``make dev`` from this
# directory so the dev override picks up — see ``Makefile``).
cd desktop && make dev
```

## Packaging

The `desktop/Makefile`, Tauri configuration, release workflows, and packaging scripts are authoritative for matrix builds, signing, notarization, and updates.
