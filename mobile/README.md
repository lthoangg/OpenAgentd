# OpenAgentd mobile

Remote-backend-only Tauri mobile shell for OpenAgentd.

The mobile app embeds the shared React Web UI from `../web/dist` and connects to an existing OpenAgentd API server. It does not bundle or start a backend.

## Local development

Run the backend and Web UI from the repo root or separate directories:

```bash
make run          # backend API on :8000
cd web && make dev # Vite Web UI on :5173
```

Then run the mobile shell:

```bash
cd mobile
make dev
```

## Icons

The mobile shell keeps `src-tauri/icons/icon.png` as the source icon. Generated icon outputs are ignored; regenerate them when the source changes:

```bash
cd mobile
make ios-icons
```

## iOS

Initialize iOS project files once. The public Apple development team
(`com.openagentd.mobile`) is configured in `src-tauri/tauri.conf.json`, so no
local team file is needed:

```bash
cd mobile
make ios-init
```

Run on simulator/device:

```bash
make ios-dev
```

Install a bundled debug build for faster iteration on a physical iPhone:

```bash
make ios-install-device-fast <device-name>
```

The fast target preserves Cargo and Xcode incremental build state and skips the Web build when `web/dist` is newer than its inputs. Before shipping, install a production build:

```bash
make ios-install-device <device-name>
```

For a physical iPhone, expose the dev servers on the LAN first:

```bash
cd ../web && bun dev --host 0.0.0.0
cd .. && OPENAGENTD_ACCESS_KEY=<choose-a-key> OPENAGENTD_ENV=development \
  cargo run --manifest-path appv3/Cargo.toml -p appv3-cli -- server serve --host 0.0.0.0 --port 8000
```

The server refuses to listen on the LAN without an access key; enter the same
key in the app's **Backend connection**. An installed CLI does the same with
`agentd server start --public --key`.

Then run the iOS dev app:

```bash
make ios-dev-device <device-name>
```

`ios-dev-device` uses the dev-only iOS bundle identifier `com.dev.openagentd.mobile` and display name `OpenAgentd Dev`, so it can be installed alongside the production app (`com.openagentd.mobile`). Override locally when needed:

```bash
make ios-dev-device <device-name> IOS_DEV_IDENTIFIER=com.example.openagentd.dev IOS_DEV_PRODUCT_NAME="OpenAgentd Dev"
```

For example, if `cargo tauri ios dev` detects a device named `OfficePhone`, run:

```bash
make ios-dev-device "OfficePhone"
```

If the generated Xcode project gets stale after changing signing or identifiers, clean and regenerate it:

```bash
make ios-clean
make ios-init
```

Build:

```bash
make ios-build
```

`ios-dev-device` uses Vite/dev servers. Use `ios-install-device` when you need to verify the built-in production UI from `../web/dist`.

### Release IPA

Each release ships a sideloadable IPA and a SideStore/AltStore source feed. The user guide is [INSTALL-IOS.md](INSTALL-IOS.md). Build and package locally on a Mac with Xcode and the signing team from `tauri.conf.json`:

```bash
make ios-ipa       # release archive -> dist/OpenAgentd_<version>_iOS.ipa + .sha256
DRY_RUN=1 make ios-release   # all checks + dist/source.json, prints the uploads
make ios-release   # upload the IPA to v<version> and source.json to latest-ios
```

`scripts/package-ipa.sh` removes the developer provisioning profile (it lists the maintainer's device UDIDs), the development signature, and the never-loaded `libapp.a` static library, then ad-hoc signs the app with no entitlements. SideStore and other sideloading tools re-sign it with the installing user's identity. `scripts/publish-ipa.sh` requires a clean tree with HEAD at the `v<version>` tag and an existing GitHub release. It generates the feed with `../scripts/make_sidestore_source.py` from the IPA's own `Info.plist` and keeps it on the rolling `latest-ios` pre-release, so the feed URL never changes and the release never becomes `releases/latest`.

If iOS blocks the first launch, trust the developer profile on the phone in **Settings → General → VPN & Device Management**.

Use **Backend connection** in the app to save/check a remote server. Simulator builds can usually reach the Mac with `http://localhost:8000`; physical devices normally need a LAN IP or HTTPS endpoint. The server has no built-in TLS: for access beyond a trusted LAN, put an HTTPS reverse proxy in front of it and connect to the proxy's URL.

The Preview tab works from the app too. The app runs a small relay on the phone's own `127.0.0.1` port and tunnels each page connection to `/api/preview/<id>/tunnel` on the server, adding the access key only to that tunnel's handshake, so the previewed page never sees it. This needs a server with an access key, and a reverse proxy must pass WebSocket upgrades for that path. While a Preview tab is open, other apps on the phone could connect to the relay and load that one preview (never `/api`); the relay closes with the tab, on a server change, and after 10 idle minutes.

For local developer builds, set a unique iOS bundle identifier in `src-tauri/tauri.conf.json` if `com.openagentd.mobile` is already registered to another Apple developer team.

## Android

Prerequisites: JDK 17+, the Android SDK (`platform-tools`, `platforms;android-36`,
`build-tools`) and an NDK, plus the Rust Android targets:

```bash
brew install openjdk@17 && brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
sdkmanager --sdk_root=$ANDROID_HOME "platform-tools" "platforms;android-36" "build-tools;36.1.0" "ndk;28.2.13676358"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Android Studio's SDK and bundled JDK work too. The Makefile defaults
`ANDROID_HOME` to `~/Library/Android/sdk` and `NDK_HOME` to the newest NDK in it.

```bash
make android-init            # generate src-tauri/gen/android and copy launcher icons
make android-dev [device]    # run on a device/emulator against Vite (bun dev --host 0.0.0.0)
make android-apk             # release APK -> dist/OpenAgentd_<version>_Android.apk + .sha256
make android-release         # android-apk + upload APK to v<version> (release keystore; DRY_RUN=1 to preview)
make android-install         # adb install -r the APK from dist/
make android-clean           # remove the generated Gradle project
```

`android-apk` builds arm64 only by default; build more ABIs with
`make android-apk ANDROID_TARGETS="aarch64 armv7 x86_64"`. It then signs the
APK with `scripts/package-apk.sh`. Set `ANDROID_KEYSTORE`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (and optionally
`ANDROID_KEY_PASSWORD`) to sign with a release key. Without them the APK is
signed with `~/.android/debug.keystore`, which is fine for your own phone
but not for distribution: Android only installs updates signed with the
same key.

`android-release` refuses to run without `ANDROID_KEYSTORE`, and
`scripts/publish-apk.sh` refuses a debug-signed APK. It needs a clean tree
with HEAD at the `v<version>` tag and an existing GitHub release. The user
guide is [INSTALL-ANDROID.md](INSTALL-ANDROID.md).

Android-specific native pieces live in the `android-plugin/` Tauri plugin
(included only in Android builds):

- Access keys go to a Keystore-backed `keyring` store. The `keyring` crate has
  no Android backend, and without this plugin it falls back to an in-memory mock.
- Downloads open the system share sheet through a `FileProvider`, like the iOS
  share sheet.
- A network security config allows `http://` servers. Release builds block
  cleartext otherwise. Android can't scope this to private IP ranges, so use
  an HTTPS reverse proxy for anything beyond a trusted LAN.

From the emulator, the host machine is `http://10.0.2.2:8000`.
