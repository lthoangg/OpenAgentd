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

## iOS release (TestFlight / App Store) runbook

iOS ships only through App Store Connect, from
`.github/workflows/release-ios.yml`, never a local Mac. Its `build` job has no
secrets and archives with `cargo tauri ios build --archive-only --no-sign`;
only `sign` signs with `scripts/sign-ipa-appstore.sh` and uploads. Never give
the build job a secret or an `environment:`
(`scripts/tests/test_release_signing_isolation.py`).

Channels (one binary; the app reads its channel at run time, see
`src-tauri/src/updater.rs` `ios_channel`):

| Channel | How | Environment |
|---|---|---|
| Dev | `make ios-install-device <name>` on your own device | none |
| Internal | `gh workflow run release-ios.yml --ref <branch> -f channel=internal` from any branch; the TestFlight Internal group gets it (turn on its automatic distribution) | `testflight-internal` (no reviewers, all branches) |
| Public Beta | the same with `-f channel=public -f confirm=release-ios` from the tag `v<X.Y.Z>`; `scripts/asc-public-beta.py` adds the build to the "Public Beta" group and submits it for Beta App Review | `release-ios` (your approval; `main` and `v*`) |
| App Store | in App Store Connect, pick the tested Public Beta build for version X.Y.Z and Submit for Review | none |

Working away from the Mac: ask the agent (through the OpenAgentd app) to run
the Internal command above for the branch; the build reaches TestFlight in
15–25 minutes. Once Apple approves X.Y.Z its version train closes and the
upload fails with "bump the version": run `scripts/bump_version.sh` first.

Apple setup: App IDs `com.openagentd.mobile` and `com.openagentd.mobile.widgets`,
both with the App Group `group.com.openagentd.mobile`; one *App Store* profile
for each; an App Store Connect record for `com.openagentd.mobile` with an Internal
group (automatic distribution on) and an external group named `Public Beta`
with a public link (linked from openagentd.dev/download/ios).

The same secrets in both `testflight-internal` and `release-ios`
(`gh secret set <NAME> --env <environment>`):

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

When a run fails: `gh run view <id> --log-failed | grep -iE "error|FAILED"`,
fix on the branch, push, and dispatch again. The `build` job takes about 20
minutes cold; Apple's bundle rules only surface in `sign` at
`altool --validate-app`, so check plist edits against them before pushing.
Apple requires `UISupportedInterfaceOrientations~ipad` to list all four
orientations (error 90474) while the iPad app supports multitasking.

App Store submission (App Store Connect, by hand):

- Screenshots: `make ios-screenshots` (iPhone 6.9" and iPad 13" from the
  simulators; `SESSIONS="<id> <id>"` adds chat screens) against a seeded
  local server; check each image before uploading.
- URLs: Privacy `https://openagentd.dev/privacy/`, Support
  `https://openagentd.dev/support/`.
- App Privacy: Data Not Collected (the app sends data only to the user's own
  server); matches `src-tauri/PrivacyInfo.xcprivacy` and the site.
- Review Notes (also Beta App Review "Test Information"): the HTTPS address
  and access key of a demo server with a spending-limited model key; that the
  app is a client for the user's own OpenAgentd server; the native parts
  (QR pairing, voice input, home-screen widgets, share sheet, photo and file
  pickers); that plugins and MCP servers run on the server and the app runs
  no downloaded code outside WebKit; and that the AI-data consent appears
  on first launch.

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
