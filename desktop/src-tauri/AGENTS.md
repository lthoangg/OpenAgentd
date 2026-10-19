# Desktop Rust/Tauri Guide

This directory owns the desktop-native shell and its bridge to the bundled
native backend sidecar (`sidecar-bundle/bin/agentd`, built from `appv3/`).

## Module map

- `src/main.rs`: app state and lifecycle orchestration.
- `src/config.rs`: window-state persistence plus the `AppHandle` adapters over
  the shared server-config code in `../../native/shell-core/` (re-exported
  under the desktop's existing names).
- `src/window.rs`: WebViews, platform chrome, zoom, and injected bridge state.
- `src/commands.rs`: Tauri commands exposed to the frontend; keyring and
  download commands are thin wrappers over `openagentd-shell-core`.
- `src/sidecar.rs`: sidecar discovery, spawn, handshake, health, and cleanup.
- `src/watchdog.rs`: restarts a crashed bundled sidecar with a bounded
  backoff budget, then re-points bundled windows; windows on an external
  server are left alone.
- `src/menu.rs`: tray/menu construction, polling, and event routing.
- `src/usage.rs`: usage formatting and shared HTTP client.
- `src/updater.rs`: update checks, download/install preconditions, and install.
- `src/network_access.rs`: the "Network access" switch: saved on/off and
  preferred port, the LAN access key in the OS credential store, and
  re-applying it to the sidecar (`/api/desktop/network-access`) after every
  sidecar start.
- `capabilities/`, `permissions/`, Tauri configs, and entitlements: native
  access and packaging contracts.

Keep `main.rs` an orchestrator; put new commands or domain behavior in the
owning module. Coordinate command/permission/plugin changes with the frontend
bridge and all relevant Tauri config variants.

## Platform invariants

- Keep the sidecar token/handshake private and preserve process-tree cleanup:
  POSIX process groups and Windows Job Objects have different paths.
  A watchdog restart reuses the same desktop token so open windows stay
  authenticated.
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
