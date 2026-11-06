# Mobile Shell Guide

This subtree is the Tauri mobile shell. It embeds the shared `web/dist` UI and
connects to an existing OpenAgentd API; it never starts or bundles a backend.
A server reachable from a phone must have an access key (it refuses a LAN bind
without one) and has no built-in TLS, so HTTPS needs a reverse proxy.

## Development and builds

From `mobile/`:

```bash
make dev                         # shell against Vite :5173
make ios-init                    # generate the local Xcode project
make ios-dev                     # simulator/device development
make ios-dev-device <name>       # named physical device
make ios-build                   # production iOS build
make ios-ipa                     # release archive -> sideloadable dist/*.ipa
make ios-release                 # local fallback: ios-ipa + upload IPA and SideStore source (DRY_RUN=1 to preview)
make android-init                # generate the local Gradle project
make android-dev [device]        # device/emulator development against Vite
make android-apk                 # release APK -> signed dist/*.apk (ANDROID_KEYSTORE* env)
make android-release             # android-apk + upload to v<version> (DRY_RUN=1 to preview)
make android-install             # adb install the dist APK
make build                       # generic Tauri bundle
```

`make ios-init` and physical-device targets require local Apple tooling and
signing. The public Apple development team is set in `src-tauri/tauri.conf.json`;
override it there only if needed. Use `make ios-install-device-fast
<name>` for a debug archive or `make ios-install-device <name>` for a
production archive/install.

`make ios-web` owns the frozen Bun install and shared web build used by native
packaging. Frontend changes still follow `web/AGENTS.md` and require web
validation.

Android needs `JAVA_HOME` (JDK 17+), `ANDROID_HOME`, and an NDK (`NDK_HOME`
defaults to the newest under `$ANDROID_HOME/ndk`). Android-only native code
(Keystore credential store, FileProvider sharing, cleartext network policy)
lives in the `android-plugin/` Tauri plugin. Its Kotlin library manifest is
merged into the generated app, so don't patch `src-tauri/gen/android/`.

Home-screen widgets: the web UI sends a snapshot through
`widget_update_snapshot` (`src-tauri/src/widgets.rs`, which refuses unknown
fields so nothing else reaches widget storage). Android draws it with the
AppWidget providers in `android-plugin/` (`Widgets.kt`). iOS uses the WidgetKit
extension in `ios-widget/`, which `scripts/patch-ios-widget.sh` adds to the
generated Xcode project (with xcodegen) before every iOS build, together with
the App Group the app and the extension share.

## iOS release (TestFlight) runbook

Releases ship from `.github/workflows/release-ios.yml`, not a local Mac. Its
`build` job has no secrets and archives with `cargo tauri ios build
--archive-only --no-sign`; only `sign`, in the `release-ios` environment (your
approval; `main` and `v*` only), signs with `scripts/sign-ipa-appstore.sh` and
uploads to TestFlight. Never give the build job a secret or an `environment:`
(`scripts/tests/test_release_signing_isolation.py`).

Apple setup: App IDs `com.openagentd.mobile` and `com.openagentd.mobile.widgets`,
both with the App Group `group.com.openagentd.mobile`; one *App Store* profile
for each; an App Store Connect record for `com.openagentd.mobile` with an
External Testing group and public link.

Secrets in `release-ios` (`gh secret set <NAME> --env release-ios`):

| Secret | Value |
|---|---|
| `IOS_DIST_CERTIFICATE` / `_PASSWORD` | base64 of the Apple Distribution `.p12` / its password |
| `IOS_PROFILE_APP` / `IOS_PROFILE_WIDGET` | base64 of the two App Store `.mobileprovision` files |
| `ASC_API_KEY` / `ASC_API_ISSUER` | App Store Connect API key ID / issuer ID (role *App Manager*) |
| `ASC_API_KEY_P8` | contents of `AuthKey_<id>.p8` |
| `KEYCHAIN_PASSWORD` | any random string |

- Renewal: profiles expire after a year and the Distribution certificate after
  one; regenerate the profiles (they must name the current certificate) and
  replace the secrets. A build already on TestFlight keeps its 90 days.
- Leak: revoke the certificate or API key in the Apple portals, then replace
  the secrets. Revoking a Distribution certificate does not remove apps users
  already installed from the App Store or TestFlight.
- The build number is the workflow run number, so every upload is unique.

## Constraints

- Keep remote-server connection behavior distinct from desktop's bundled
  sidecar flow.
- Treat remote-origin validation, access-key storage, Tauri capabilities/CSP,
  deep links, iOS plist/privacy changes, and the Android plugin's manifest,
  network security config, and Keystore code as security-sensitive.
- `src-tauri/gen/`, `src-tauri/target/`, and generated icon variants are
  local/generated state. Regenerate them with Make targets instead of editing
  or committing them.
- `src-tauri/icons/icon.png` is a generated copy of
  `documents/assets/brand/openagentd-app-icon.png`; use `make ios-icons`,
  `make ios-icons-force`, or `make android-icons` for generated variants
  (`scripts/generate_icons.py`).

## Checks

```bash
make verify-mobile  # from repository root; locked cargo check used by CI
```

iOS and Android builds and device behavior are not covered by CI. Run the
smallest relevant simulator/emulator/device flow for native changes (for
Android at least `make android-apk`), and report when the required Apple or
Android tooling is unavailable.
