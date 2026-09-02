# Mobile Rust/Tauri Guide

This directory owns the remote-backend bridge, secure access-key commands,
native file handling/sharing, deep links, notifications, haptics, and iOS
integration for the mobile shell.

## Where to look

- `src/lib.rs`: Tauri commands, runtime backend state, the reachability gate,
  iOS share-sheet handling, plugin setup, and mobile-only unit tests.
- `../../native/shell-core/`: server config persistence, URL normalization,
  keyring access, and download limits shared with the desktop shell. Change
  those behaviours there, with their tests, not in `lib.rs`.
- `tauri.conf.json`: shared web build hook, window/bundle metadata, CSP, deep
  links, and packaged icons.
- `capabilities/default.json`: frontend-to-native permissions.
- `Info.ios.plist` and `PrivacyInfo.xcprivacy`: iOS platform declarations.

## Boundaries

- Accept only normalized HTTP(S) backend origins and health-check a server
  before persisting it. Keep access keys in the platform keyring, not the JSON
  server configuration or frontend storage.
- Preserve file download size/path validation and iOS share-sheet main-thread
  behavior when changing native file flows.
- Update Tauri capabilities with any plugin/command surface change. Review CSP
  changes together with the remote origins and WebView APIs that require them.
- Keep platform-specific code behind `cfg` gates and retain portable behavior
  for the host-side Cargo check.

## Checks

From the repository root:

```bash
make verify-mobile
```

For focused iteration from this directory, match CI:

```bash
TAURI_CONFIG='{"bundle":{"icon":["icons/icon.png"]}}' cargo check --locked
TAURI_CONFIG='{"bundle":{"icon":["icons/icon.png"]}}' cargo test --locked
```

The root mobile target matches CI and runs only `cargo check`; run the focused
unit tests above when changing `src/lib.rs` behavior.
