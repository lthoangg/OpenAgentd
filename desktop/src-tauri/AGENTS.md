# desktop/src-tauri/ — Agent Instructions

Rust/Tauri app that launches the Python sidecar, injects desktop auth, owns tray/window behavior, and builds native bundles.

## Where to look first

```
src/                         Rust application code:
                             - main.rs: AppState, app lifecycle, startup orchestration, and unit tests
                             - config.rs: Config and window state load/save logic
                             - window.rs: Window creation, custom chrome/styling, zoom, and webview scripts
                             - updater.rs: Update checking, downloading, and installation
                             - menu.rs: Menu bar, system tray setup, and event routing
                             - commands.rs: Tauri command handlers exposed to the frontend
                             - sidecar.rs: Sidecar process supervisor
                            - usage.rs: Connected-provider usage fetch + tray "Usage Limits" row formatting (pure/unit-tested)
Cargo.toml                   Rust package, Tauri/plugin deps, minimum Rust version
tauri.conf.json              Production Tauri config
tauri.dev.conf.json          Dev shell config against external Vite/backend
tauri.dev-bundled.conf.json  Dev shell config with bundled sidecar
capabilities/ permissions/   Tauri permission model
icons/                       Source/generated app icons
build.rs                     Tauri build integration
```

## Common feature checks

- Sidecar startup/auth change: inspect supervisor code in `src/sidecar.rs`, startup orchestration in `src/main.rs`, and commands in `src/commands.rs`.
- Window/Tray behavior: inspect `src/window.rs` for window behavior/zoom, and `src/menu.rs` for tray/menu setups.
- Tray "Usage Limits" change: formatting/thresholds/notification-dedup live in `src/usage.rs` (pure, unit-tested — also home of the process-wide shared `reqwest` client, `shared_client()`); polling loop, tray-open refresh, in-flight guard, row diffing, and menu-click routing live in `src/menu.rs` (`run_usage_poll_loop`, `refresh_usage_now`, `refresh_usage_on_tray_open`, `update_tray_usage`). Backend aggregation is `app/services/provider_usage.py::get_connected_provider_usage_summary` (stale-while-revalidate + per-provider last-known-good fallback).
- Updater/Installer behavior: inspect `src/updater.rs` and `src/main.rs`'s unit tests.
- Config/Persisted State: inspect `src/config.rs`.
- Bundle/config change: update all relevant Tauri config variants, not just production.
- Permission/plugin change: update Tauri capabilities and verify frontend plugin usage.
- Release/update change: check `desktop/Makefile`, `scripts/make_updater_manifest.py`, and `documents/docs/desktop.md`.

## Commands

```bash
cargo check
cargo tauri dev -c tauri.dev.conf.json
cargo tauri build
```

Usually invoke through parent targets:

```bash
make -C desktop dev
make -C desktop build
```

## Gotchas

- Dev mode with external backend depends on root `make dev` already running.
- Keep macOS, Windows, and Linux lifecycle behavior in mind when changing process cleanup.
- Do not commit `target/`, generated bundles, or machine-local `.openagentd/` state.
- **Updater restart is platform-specific:** on macOS `install()` replaces the process itself — calling `app.restart()` afterwards creates a second, racing relaunch that restarts the *old* binary. The install command uses `#[cfg(target_os = "macos")]` / `#[cfg(not(target_os = "macos"))]` to branch; do not collapse this into a single post-install `restart()`. A `quitting` guard at the top of `run_update_install` rejects double-invokes.
