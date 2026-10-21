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
- `../android-plugin/`: Android-only Tauri plugin (Rust + Kotlin). It holds the
  Keystore-backed `keyring` credential store, FileProvider file sharing, and
  the cleartext network security config. It's registered first in `run()` on
  Android.

## Boundaries

- Accept only normalized HTTP(S) backend origins and health-check a server
  before persisting it. Keep access keys in the platform keyring, not the JSON
  server configuration or frontend storage.
- Preserve file download size/path validation and iOS share-sheet main-thread
  behavior when changing native file flows.
- Update Tauri capabilities with any plugin/command surface change. Review CSP
  changes together with the remote origins and WebView APIs that require them.
- The capability grants IPC to the app origin only (`local`: the bundled UI,
  or `devUrl` in debug builds). Don't add `remote` URLs: they would also cover
  server pages and the preview relay's `http://127.0.0.1:<port>` frames, and
  hand them `secure_get_access_key`. A test in `src/lib.rs` enforces this.
- The preview relay commands (`preview_relay_open`/`_close`) take only a
  preview id and port; the server URL and key come from native state. Keep
  it that way, and close relays when the active server changes.
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
