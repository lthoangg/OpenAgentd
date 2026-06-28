---
name: oad/tauri
description: OpenAgentd workflow for developing, configuring, and shipping the Tauri (Rust) desktop and mobile shells.
---

Build, configure, and ship Tauri/Rust code for the OpenAgentd **desktop** (`desktop/src-tauri/`) and **mobile** (`mobile/src-tauri/`) shells.

> **Debugging Tauri issues?** Load `oad/debug` + `oad/debug/reference/tauri` instead — this skill focuses on development and release, not investigation.

---

## Architecture overview

| Shell | Path | Role |
|---|---|---|
| Desktop | `desktop/src-tauri/` | Supervises Python sidecar, tray, multi-window, auto-update, native bundles |
| Mobile | `mobile/src-tauri/` | Minimal shell — no sidecar, embeds web UI, connects to remote API |
| Shared Web UI | `web/` | React app consumed by both shells via `web/dist` |
| Python backend | `app/` | Bundled inside desktop; always external for mobile |

---

## Desktop

### Dev workflow

```bash
# Prerequisites — start backend + Vite first
make dev                            # repo root

# Desktop shell (separate terminal)
make -C desktop dev                 # against external backend + Vite
make -C desktop dev-bundled         # against bundled sidecar
```

### Build & package

```bash
make -C desktop sidecar             # slim Python sidecar bundle
make -C desktop sidecar-full        # + audio + Azure Document Intelligence extras
make -C desktop icons               # regenerate from src-tauri/icons/icon.png
make -C desktop build               # release build (dmg, app, msi, deb, appimage)
make -C desktop clean
```

### Key files

```
src/main.rs              App entry, AppState, tray, window management, IPC commands, updater
src/sidecar.rs           Sidecar process supervisor + auth-token handshake
Cargo.toml               Deps: Tauri 2, tokio, anyhow, serde, plugins
tauri.conf.json          Production (updater, asset-protocol scope, native bundles)
tauri.dev.conf.json      Dev against external backend + Vite
tauri.dev-bundled.conf.json  Dev against bundled sidecar
capabilities/ permissions/   Tauri permission model
```

### Plugin inventory

| Plugin | Purpose |
|---|---|
| `tauri-plugin-updater` | Auto-update via GitHub releases |
| `tauri-plugin-opener` | Open URLs / files in OS default handler |
| `tauri-plugin-dialog` | Native dialogs |
| `tauri-plugin-notification` | OS notifications |
| `tauri-plugin-process` | App restart / exit |
| `tauri-plugin-log` | Structured logging to file + console |
| `tauri-plugin-single-instance` | Prevent duplicate windows |

### Config variants — always keep all three consistent

When changing window config, CSP, plugin config, or permissions update **all three**:
1. `tauri.conf.json` — production
2. `tauri.dev.conf.json` — external dev
3. `tauri.dev-bundled.conf.json` — bundled dev

### Common change patterns

| Goal | Where to look |
|---|---|
| Sidecar startup / auth | `src/sidecar.rs`, `app.cli serve`, `app.core.desktop_auth` |
| Tray menu / icon | `src/main.rs` → `build_tray` / menu builders |
| Window creation / sizing | `src/main.rs` `WebviewWindowBuilder` + all three configs |
| Open URL in browser | `OpenerExt::open_url` — already wired |
| Auto-update flow | `src/main.rs` updater section + updater plugin config |
| Permission / CSP | `capabilities/`, `permissions/`, `tauri.conf.json` → `app.security.csp` |
| New Tauri plugin | `Cargo.toml` dep + `capabilities/` entry + `tauri::Builder` registration |
| Release / signing / update manifest | `desktop/Makefile`, `scripts/make_updater_manifest.py`, `documents/docs/desktop.md` |

---

## Mobile

### Dev workflow

```bash
# Start backend + Vite first
make run                            # backend on :8000
cd web && make dev                  # Vite on :5173

make -C mobile dev                  # Android emulator / device
make -C mobile ios-dev              # iOS simulator / device
```

### iOS setup (once per checkout)

```bash
printf 'TEAMID' > mobile/ios-team.txt   # git-ignored; use your Apple team ID
make -C mobile ios-init                  # initialize Xcode project
make -C mobile ios-icons                 # generate icons from src-tauri/icons/icon.png
```

Physical device with dev servers:

```bash
cd web && bun dev --host 0.0.0.0
uv run uvicorn app.server:app --host 0.0.0.0 --port 8000
make -C mobile ios-install-device <device-name>
```

### Key files

```
src/main.rs              Minimal app entry — no sidecar, no tray
Cargo.toml               Minimal deps (no updater, no sidecar plugins)
tauri.conf.json          Window size, CSP, iOS/Android bundle config
```

### Common change patterns

| Goal | Where to look |
|---|---|
| Window size / orientation | `tauri.conf.json` → `app.windows[0]` |
| CSP (new domain) | `tauri.conf.json` → `app.security.csp` |
| New Tauri plugin | `Cargo.toml` + `capabilities/` + `src/main.rs` registration |
| Icon update | `src-tauri/icons/icon.png` → `make -C mobile ios-icons` |

---

## Cross-cutting rules

1. **Rust edition**: 2021, MSRV 1.77.
2. **Tauri version**: 2.x — use v2 APIs only.
3. **Error handling**: `anyhow::Result` + `.context("…")` for chain messages.
4. **Async**: Tauri commands are `async`; use `tokio::sync::Mutex` for shared state.
5. **IPC**: emit events with `AppHandle::emit`; JS calls Rust via `invoke` + capability entry.
6. **Permissions**: every new command or plugin needs a `capabilities/` entry.
7. **Never commit**: `target/`, sidecar bundles, or `.openagentd/` local state.
8. **Docs**: update `documents/docs/desktop.md` when release, signing, or operator workflow changes.
