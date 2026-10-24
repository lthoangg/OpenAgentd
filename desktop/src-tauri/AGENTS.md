# Desktop Rust/Tauri Guide

This directory owns the desktop-native shell and its bridge to the bundled
native backend sidecar (`sidecar-bundle/bin/agentd`, built from `appv3/`).

## Module map

- `src/main.rs`: app state and lifecycle orchestration.
- `src/config.rs`: window-state persistence plus the `AppHandle` adapters over
  the shared server-config code in `../../native/shell-core/` (re-exported
  under the desktop's existing names).
- `src/window.rs`: WebViews, platform chrome, zoom, and injected bridge state.
- `src/servers.rs`: which server each window is on (`ServerId`: builtin or
  one external URL). The notch, the tray's "Auto" usage, new windows and
  notification routing all ask it. A saved server is never chosen here;
  it only becomes a window's server when the user clicks Connect.
- `src/commands.rs`: Tauri commands exposed to the frontend; access-key and
  download commands are thin wrappers over `openagentd-shell-core`.
- `src/sidecar.rs`: sidecar discovery, spawn, handshake, health, and cleanup.
- `src/watchdog.rs`: restarts a crashed bundled sidecar with a bounded
  backoff budget, then re-points bundled windows; windows on an external
  server are left alone.
- `src/menu.rs`: tray/menu construction, polling, and event routing. Usage
  snapshots, errors and alert dedup are kept per server (`usage::UsageCache`).
- `src/island.rs`: the macOS notch island (`web/island.html`): follows the
  event stream of every server with a window open (one task per server,
  started and stopped by a 2 s supervisor), refetches each one's
  active-session list, merges them, and places the window over the notch
  with AppKit. Its webview has its own capability
  (`capabilities/island.json`) and, like the tray popup, never gets the
  backend token (`window::is_overlay_window`).
- `src/usage.rs`: usage formatting and shared HTTP client.
- `src/updater.rs`: update checks, download/install preconditions, and install.
- `src/network_access.rs`: the "Network access" switch: saved on/off and
  preferred port, the LAN access key in a user-only file, and
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
- `install()` (tauri-plugin-updater >= 2.14) verifies the bytes it is given,
  so pass the downloaded archive unchanged; never re-sign or repack it on the
  client. It swaps the bundle and returns (Windows exits into the
  installer); restart exactly once afterwards. Preserve the double-invoke
  quitting guard.
- Desktop secrets (access keys, the LAN key) live in user-only files, not
  the OS keychain: macOS ties keychain items to the app's Team ID, which the
  unsigned app lacks, so each update would prompt again.
- Review CSP, remote origins, capabilities, entitlements, updater signing, and
  secret storage changes as security-sensitive.

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
