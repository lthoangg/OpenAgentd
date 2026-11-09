# Mobile Rust/Tauri Guide

This directory owns the remote-backend bridge, secure access-key commands,
native file handling/sharing, deep links, notifications, haptics, and iOS
integration for the mobile shell.

## Where to look

- `src/lib.rs`: Tauri commands, runtime backend state, the reachability gate,
  iOS share-sheet handling, plugin setup, and mobile-only unit tests.
- `src/widgets.rs`: the home-screen widget snapshot: its shape (unknown
  fields refused), limits, and the hand-off to the iOS Swift bridge
  (`../ios-widget/App/`) or the Android plugin.
- `src/push.rs`: APNs registration (iOS only; elsewhere `unsupported`):
  `push_status` (no prompt) and `push_register` (prompts once) resolve to
  `{ status, registration, error? }`, where `registration` is agentd-cloud's
  `POST /v1/push/register` body. The environment comes from the bundle's
  `embedded.mobileprovision` (none: production), never a guess. The Swift
  half, `../ios-widget/App/PushBridge.swift`, adds the token callbacks to
  tao's app delegate class at runtime. Nothing is sent to a server yet;
  release builds never log the token.
- `src/native_ui.rs`: `share_text` (the system share sheet for a link) and
  `pick_one` (a native single-choice picker: iOS action sheet, Android
  dialog). Input is validated and bounded once, for both platforms; the iOS
  UIKit code runs on the main queue and answers over a channel, the Android
  half is `ShellPlugin.kt`'s `shareText`/`pickOne`. The web no longer calls
  `pick_one`: menus and pickers are the app's own on every platform. The web
  command `share_text` has no web caller yet; keep errors as `Err`, never a
  silent success.
- `src/keyboard_bar.rs` (iOS): hides the WebView's form accessory bar
  (`< > ✓` above the keyboard) at setup by moving WKWebView's content view to
  a subclass whose `inputAccessoryView` is nil. On iOS 26 the floating bar is
  not taken out of `visualViewport` and covered the composer. The keyboard is
  put away by the composer's swipe down or a tap on the transcript. A renamed
  content view matches nothing and the bar simply shows again.
- `../../native/shell-core/`: server config persistence, URL normalization,
  keyring access, and download limits shared with the desktop shell. Change
  those behaviours there, with their tests, not in `lib.rs`.
- `tauri.conf.json`: shared web build hook, window/bundle metadata, CSP, deep
  links, and packaged icons.
- `capabilities/default.json`: frontend-to-native permissions.
- `Info.ios.plist` and `PrivacyInfo.xcprivacy`: iOS platform declarations.
- `../android-plugin/`: Android-only Tauri plugin (Rust + Kotlin). It holds the
  Keystore-backed `keyring` credential store, FileProvider file sharing, link
  sharing and the picker dialog, the WebView's `textZoom` (the system font
  size, capped at 1.25x like iOS Dynamic Type), and the cleartext network
  security config. It's registered first in `run()` on Android.

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
- The host `cargo check` compiles none of the iOS or Android code. After
  changing a `cfg(target_os = ...)` block, also run
  `cargo check --locked --target aarch64-apple-ios` (and, with the NDK's clang
  as `CC_aarch64_linux_android`/linker, `--target aarch64-linux-android`).

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
