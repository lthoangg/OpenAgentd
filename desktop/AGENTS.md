# desktop/ — Agent Instructions

Tauri v2 desktop shell that supervises the Python sidecar, opens the embedded web UI, and owns desktop packaging.

## Tech stack

- Rust 2021, minimum Rust 1.77.2.
- Tauri 2 with updater, opener, dialog, notification, process, log, and single-instance plugins.
- Python sidecar bundle is API-only; the React Web UI is packaged by Tauri from `web/dist`.

## Layout

```
src-tauri/       Rust app, Tauri config, icons, Cargo project
  src/           Modular Rust source:
                 - main.rs: Shared AppState, app lifecycle orchestration, and unit tests.
                 - config.rs: App server configurations, server normalization, and window state persistence.
                 - window.rs: Window creation, macOS/cross-platform chrome styling, zoom, and webview scripts.
                 - updater.rs: Update checking, downloading, install preconditions, and installation logic.
                 - menu.rs: Menu bar setup, system tray icon, status updates, and menu event routing.
                 - commands.rs: Tauri command handlers invoked by the React frontend.
                 - sidecar.rs: Python sidecar process supervisor.
                 - usage.rs: Connected-provider usage fetch + tray "Usage Limits" formatting.
scripts/         Desktop packaging/release helper scripts
sidecar-bundle/  Generated Python sidecar output (build artifact)
Makefile         Desktop dev, sidecar, icon, and build targets
README.md        Architecture and packaging notes
```

## Essential commands

```bash
make -C desktop sidecar       # build slim sidecar bundle
make -C desktop sidecar-full  # include audio + Azure Document Intelligence extras
make -C desktop icons         # regenerate icons from src-tauri/icons/icon.png
make -C desktop dev           # Tauri shell against root make dev
make -C desktop dev-bundled   # Tauri shell with bundled sidecar
make -C desktop build         # release desktop build
make -C desktop clean
```

For normal desktop development, run `make dev` at the repo root first, then `make -C desktop dev` in another terminal.

## Code style

- Maintain modularity: Keep `main.rs` focused on orchestration, lifecycle, and the core test suite. Place new Tauri commands in `commands.rs` or their respective domain modules, configuration logic in `config.rs`, window modifications in `window.rs`, and updater logic in `updater.rs`.
- Keep sidecar lifecycle and auth-token handshake changes small and platform-aware.
- Preserve dev/prod config split (`tauri.dev.conf.json`, `tauri.dev-bundled.conf.json`, production config).
- Do not commit generated sidecar bundles or target artifacts.

## Source of truth

- Local architecture: `README.md` and the Rust modules named above.
- Release, signing, and updater behavior: `Makefile`, Tauri configuration, scripts, and release workflows.
- Treat webview CSP and macOS entitlement changes as security-sensitive: trace their call sites and platform requirements before tightening them.
