# Debug reference: Tauri shells (desktop and mobile)

Use for the native layer: sidecar lifecycle, windows, tray, IPC, permissions,
CSP, updater, and plugins.

| Shell | Path | Role |
|---|---|---|
| Desktop | `desktop/src-tauri/` | supervises the bundled `agentd` sidecar (built from `appv3/`), tray, windows, updater |
| Mobile | `mobile/src-tauri/` | remote-only: connects to an existing API, no sidecar |
| Shared | `native/shell-core/` | Tauri-free: server config, URL normalization, keyring access keys, download limits |

## Run

```bash
cd web && bun dev               # terminal 1: Vite :5173
make -C desktop dev             # terminal 2: dev shell (tauri.dev.conf.json), bundled-sidecar connection model
make -C desktop dev-bundled     # builds the sidecar first; state shared with root `make dev` via .openagentd/dev/
make -C desktop sidecar         # stage appv3's binary into desktop/sidecar-bundle/
make -C mobile dev              # mobile shell against the Vite dev server
make -C mobile ios-dev          # iOS simulator or device
```

`make -C desktop dev` and `build` need `cargo tauri` (tauri-cli 2). The dev
identity coexists with an installed production app (separate bundle id, logs,
and tray). External servers are added from the app's Server connection dialog.

## Fast checks

```bash
cd desktop/src-tauri && TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo check --locked
cd desktop/src-tauri && TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo clippy --locked --all-targets
make verify-desktop    # check + test + clippy, as CI runs them
make verify-mobile
make verify-shell-core
```

## File map (desktop)

```
desktop/src-tauri/
  src/main.rs         app entry, AppState, run-event handling, IPC registration
  src/sidecar.rs      sidecar spawn, port detection, token handshake, log files
  src/window.rs       window builders and init scripts (frontend token, backend URL)
  src/updater.rs      update check, install, restart
  src/menu.rs  tray_popup.rs  usage.rs  watchdog.rs  commands.rs  config.rs
  tauri.conf.json              production config (updater endpoint, CSP, bundles)
  tauri.dev.conf.json          dev identity (used by `make dev` and verify-desktop)
  tauri.dev-bundled.conf.json  dev with the bundled sidecar
  capabilities/default.json    which commands and plugins the webview may call
```

## Failure boundaries

| Symptom | Where to look |
|---|---|
| Sidecar won't start or exits | `sidecar.rs`: args, env, port; then the backend log (`references/production.md`) |
| Token missing or rejected | `sidecar.rs` handshake → `appv3/crates/api/src/middleware.rs` (`desktop_token`) |
| Window missing or wrong size | `window.rs` builders and all three config variants |
| IPC command not found | `#[tauri::command]`, `invoke_handler` registration, and a `capabilities/` entry |
| CSP blocks a resource | `app.security.csp` in every config variant |
| Update installs but the old version reopens | macOS `install()` relaunches itself; a later `app.restart()` races it. Check `updater.rs` for a post-install restart and for a second click while installing |
| Process left running on quit | `RunEvent::ExitRequested` / `WindowEvent::CloseRequested` handling in `main.rs` |
| iOS signing | the Apple `developmentTeam` in `mobile/src-tauri/tauri.conf.json` |

Keep the three desktop config variants consistent when changing windows, CSP,
plugins, or permissions. Treat CSP, capabilities, keyring, and updater signing
as security-sensitive.
