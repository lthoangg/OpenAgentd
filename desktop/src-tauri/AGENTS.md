# Desktop Rust/Tauri Guide

This directory owns the desktop-native shell and its bridge to the bundled
native backend sidecar (`sidecar-bundle/bin/agentd`, built from `appv3/`).

## Module map

- `src/main.rs`: app state and lifecycle orchestration.
- `src/config.rs`: window-state persistence plus the `AppHandle` adapters over
  the shared server-config code in `../../native/shell-core/` (re-exported
  under the desktop's existing names).
- `src/window.rs`: WebViews, platform chrome, zoom, and injected bridge state.
  A new window opens at the zoom of the window it was opened from, else the
  last zoom chosen (`shell_prefs`). Windows and Linux hide the native menu
  bar; the app menu opens from the header's ☰ button or an Alt tap
  (`context_menu::show_app_menu`).
- `src/shell_prefs.rs`: `desktop-shell.json`, the shell-level preferences that
  outlive a session: the last zoom and the global shortcuts switch.
- `src/context_menu.rs`: the app menu as a pop-up on Windows/Linux
  (`show_app_menu`). The page draws its own menus (right-click, ⋯) in every
  shell; native means the feel, not the OS widget.
- `src/app_menu.rs`: the View → Text Size check items. The page owns the
  setting and reports it with `set_menu_text_size`; a click only emits a
  command for the page.
- `src/badge.rs`: the "Needs you" attention badge (`set_attention_badge`):
  dock/launcher badge on macOS/Linux, a generated taskbar overlay per window
  on Windows.
- `src/share.rs`: the system share sheet (`share_url`): `NSSharingServicePicker`
  on macOS, `DataTransferManager` on Windows, "unsupported" on Linux.
- `src/haptics.rs`: the trackpad "alignment" tick (`haptic_alignment`,
  `NSHapticFeedbackManager` on the main thread) the page fires when a resize
  drag snaps onto its default; a no-op `Ok` on every other platform.
- `src/global_shortcuts.rs`: opt-in system-wide shortcuts. The plugin is only
  started once the user ticks "Global Shortcuts"; nothing is registered by
  default.
- `src/servers.rs`: which server each window is on (`ServerId`: builtin or
  one external URL). The notch, the tray's "Auto" usage, new windows and
  notification routing all ask it. A saved server is never chosen as a
  window's server here; it only becomes one when the user clicks Connect.
  The notch additionally follows the builtin while it runs and saved
  servers marked `enabled` (`followed_servers`), with or without a window.
- `src/commands.rs`: Tauri commands exposed to the frontend; access-key and
  download commands are thin wrappers over `openagentd-shell-core`.
- `src/sidecar.rs`: sidecar discovery, spawn, handshake, health, and cleanup.
- `src/lifecycle.rs`: `SidecarSlot`, the single owner of the bundled sidecar.
  Every start, reload, stop and watchdog restart takes a decision from it;
  an attempt superseded by a later decision (it is woken at once) shuts its
  own child down instead of publishing it, and the watchdog never takes a
  crash while a start is in flight. A child dropped before it is published
  is killed.
- `src/watchdog.rs`: restarts a crashed bundled sidecar with a bounded
  backoff budget, then re-points bundled windows; windows on an external
  server are left alone.
- `src/menu.rs`: tray/menu construction, polling, and event routing. Usage
  snapshots, errors and alert dedup are kept per server (`usage::UsageCache`).
- `src/island.rs`: the macOS notch island (`web/island.html`): follows the
  event stream of every server with a window open and every enabled saved
  server (one task per server, started and stopped by a 2 s supervisor,
  woken by `servers_changed` when the saved list changes), refetches each one's
  active-session list, merges them, and places the window over the notch
  with AppKit. Unread follows the sidebar's rules (no row for a stopped,
  idle-compaction or `quiet` turn); each server's memo and last list outlive
  a reconnect. It keeps each feed's `WatchState` (read by Settings through
  `app_server_watch_states`). Its webview has its own capability
  (`capabilities/island.json`, like the tray popup's `capabilities/tray.json`)
  and, like the tray popup, never gets the backend token
  (`window::is_overlay_window`).
  The feed runs on every platform, always: the tray's "Needs you" list and
  mark read it too. Its `open_session` is the one session → window router:
  every way to open a session (island, pet, tray, OS notification, "Open in
  new window", `app_new_window` with a session path) focuses the window that
  already shows it (every app window reports its session through
  `island_viewing`, on all desktop OSes), else uses the server's window, else
  opens one. `answer_question` posts an answer and clears the question on
  every surface.
- `src/answers.rs`: reads the open question of a session
  (`GET /api/agent/{id}/question`) and posts an answer, with the server's
  credential. Only OS notifications answer in place, and only one plain
  single-choice question with a few short options (`quick_choices`); the
  island and the pet never answer: a click opens the session. A 409/404 on the
  answer means it is no longer open: treated as answered elsewhere.
- `src/pet.rs`: the desktop pet (`web/pet.html`, macOS and Windows): a
  transparent always-on-top window that is only a full-width lane of a
  display's work area, as tall as the pet's scene needs (the whole area
  while it is dragged), so a meeting app's window picker finds no sheet over
  the desktop. The page works in work-area pixels and asks for its lane
  with its clickable areas (`pet_fit`); Rust clamps it (`window_frame`),
  moves the window and answers `pet-frame`. Hit areas, pointer, ledges and
  the saved position stay in work-area pixels. Rust polls the
  pointer to switch click-through, like the island. It gets the island
  feed's status and `desktop_notification` events, and
  `show_desktop_notification` asks `pet::take_banner` first: the pet takes
  a banner only while it is on screen. Its webview has its own capability
  (`capabilities/pet.json`) and never gets the backend token.
  A question stays with the pet until it is answered ("Later" folds it behind
  the badge); the right-click menu lists questions first.
- `src/usage.rs`: usage formatting and shared HTTP client.
- `src/updater.rs`: update checks, download/install preconditions, and install.
- `src/diagnostics.rs`: Help → Export Diagnostics: copies the desktop and
  backend logs into a Downloads folder with `about.txt`. Every line passes
  through `redact_secrets`, because the backend log records shell commands
  that can carry the user's keys; new log sources must go through it too.
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
  installer); restart exactly once afterwards. A second install, or a new
  download, is refused while the install lease (`update_install`) is held
  (a download already running may finish); the install verifies and
  installs the one copy of the bytes it read, before the sidecar is shut
  down.
- Desktop secrets (access keys, the LAN key) live in user-only files, not
  the OS keychain. Releases before Developer ID signing had no Team ID, so
  keychain items would have prompted on every update; moving them now needs
  a migration for those installs.
- Review CSP, remote origins, capabilities, entitlements, updater signing, and
  secret storage changes as security-sensitive.

## macOS release signing (runbook)

`release-desktop.yml` builds with no secrets; only its `sign` job, in the
`release-macos` environment (your approval; `main` and `v*` only), signs,
notarizes and writes updater `.sig` files via
`desktop/scripts/sign-macos-release.sh`. Build jobs must never get a signing
secret or an `environment:` (`scripts/tests/test_release_signing_isolation.py`).

Secrets in `release-macos` (set with `gh secret set <NAME> --env release-macos`):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | its export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
| `APPLE_TEAM_ID` | Team ID |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` | App Store Connect API key ID / issuer ID (role *Developer*) |
| `APPLE_API_KEY_P8` | contents of `AuthKey_<id>.p8` |
| `KEYCHAIN_PASSWORD` | any random string (`openssl rand -base64 24`) |
| `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` | updater minisign key (`scripts/generate_updater_keys.sh`) |

- Renewal: the Developer ID certificate lasts 5 years. Create the new one
  before expiry and replace the two certificate secrets; the Team ID, and so
  the designated requirement and users' privacy grants, stay the same.
  Releases already shipped stay valid (secure timestamp).
- Leak: revoke the certificate (developer.apple.com → Certificates) or the API
  key (App Store Connect → Users and Access → Integrations), then replace the
  secrets. Revoking a Developer ID certificate also invalidates apps signed with
  it after the revocation date Apple sets, so ask Apple to pick the date.
- Keep the `.p12`, `.p8` and their passwords in a password manager, never in
  the repository or a repo-level secret.

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
