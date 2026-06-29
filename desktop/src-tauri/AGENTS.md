# desktop/src-tauri/ — Agent Instructions

Rust/Tauri app that launches the Python sidecar, injects desktop auth, owns tray/window behavior, and builds native bundles.

## Where to look first

```
src/                         Rust application code
Cargo.toml                   Rust package, Tauri/plugin deps, minimum Rust version
tauri.conf.json              Production Tauri config
tauri.dev.conf.json          Dev shell config against external Vite/backend
tauri.dev-bundled.conf.json  Dev shell config with bundled sidecar
capabilities/ permissions/   Tauri permission model
icons/                       Source/generated app icons
build.rs                     Tauri build integration
```

## Common feature checks

- Sidecar startup/auth change: inspect Rust supervisor code, `app.cli serve`, `app.core.desktop_auth`, and desktop tests.
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
