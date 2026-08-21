# Desktop Rust/Tauri Guide

This directory owns the desktop-native shell and its Python sidecar bridge.

## Module map

- `src/main.rs`: app state and lifecycle orchestration.
- `src/config.rs`: saved servers and window/config persistence.
- `src/window.rs`: WebViews, platform chrome, zoom, and injected bridge state.
- `src/commands.rs`: Tauri commands exposed to the frontend.
- `src/sidecar.rs`: sidecar discovery, spawn, handshake, health, and cleanup.
- `src/menu.rs`: tray/menu construction, polling, and event routing.
- `src/usage.rs`: usage formatting and shared HTTP client.
- `src/updater.rs`: update checks, download/install preconditions, and install.
- `capabilities/`, `permissions/`, Tauri configs, and entitlements: native
  access and packaging contracts.

Keep `main.rs` an orchestrator; put new commands or domain behavior in the
owning module. Coordinate command/permission/plugin changes with the frontend
bridge and all relevant Tauri config variants.

## Platform invariants

- Keep the sidecar token/handshake private and preserve process-tree cleanup:
  POSIX process groups and Windows Job Objects have different paths.
- On macOS updater installation replaces the process; do not add the
  non-macOS post-install `app.restart()` path there. Preserve the double-invoke
  quitting guard.
- Review CSP, remote origins, capabilities, entitlements, updater signing, and
  keyring changes as security-sensitive.

## Checks

From the repository root, prefer:

```bash
make verify-desktop
```

For focused commands in this directory, match CI's configuration:

```bash
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo check --locked
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo test --locked
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo clippy --locked --all-targets
```
