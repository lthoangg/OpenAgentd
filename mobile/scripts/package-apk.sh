#!/usr/bin/env bash
#
# Sign the release APK from `cargo tauri android build --apk` for sideloading.
#
# Gradle emits an unsigned release APK. This aligns and signs it with the
# keystore named by the environment:
#
#   ANDROID_KEYSTORE           path to the .jks/.keystore file
#   ANDROID_KEYSTORE_PASSWORD  store password
#   ANDROID_KEY_ALIAS          key alias
#   ANDROID_KEY_PASSWORD       key password (defaults to the store password)
#
# Android only installs an update signed with the same key as the installed
# app, so releases must always use one long-lived keystore. Without
# ANDROID_KEYSTORE the APK is signed with the local debug keystore and a
# warning: fine for your own phone, not for distribution.
#
# Output: dist/OpenAgentd_<version>_Android.apk and its .sha256.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(../scripts/release_version.sh)"
APK_DIR="src-tauri/gen/android/app/build/outputs/apk"
DIST_DIR="dist"
APK_NAME="OpenAgentd_${VERSION}_Android.apk"

die() {
  echo "package-apk: error: $*" >&2
  exit 1
}

: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"

# Newest installed build-tools provides zipalign and apksigner.
build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)"
[ -n "$build_tools" ] || die "no build-tools under $ANDROID_HOME/build-tools (sdkmanager 'build-tools;36.1.0')"
zipalign="$build_tools/zipalign"
apksigner="$build_tools/apksigner"

# Tauri builds one universal APK unless --split-per-abi is passed.
unsigned="$(find "$APK_DIR" -path '*release*' -name '*-release-unsigned.apk' 2>/dev/null | head -n 1)"
[ -n "$unsigned" ] || die "no unsigned release APK under $APK_DIR (run 'make android-apk')"

if [ -n "${ANDROID_KEYSTORE:-}" ]; then
  [ -f "$ANDROID_KEYSTORE" ] || die "ANDROID_KEYSTORE=$ANDROID_KEYSTORE does not exist"
  : "${ANDROID_KEYSTORE_PASSWORD:?set ANDROID_KEYSTORE_PASSWORD}"
  : "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS}"
  keystore="$ANDROID_KEYSTORE"
  alias="$ANDROID_KEY_ALIAS"
  # Pass passwords through the environment, never on the command line.
  export OAD_KS_PASS="$ANDROID_KEYSTORE_PASSWORD"
  export OAD_KEY_PASS="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
else
  keystore="$HOME/.android/debug.keystore"
  alias="androiddebugkey"
  export OAD_KS_PASS="android" OAD_KEY_PASS="android"
  if [ ! -f "$keystore" ]; then
    mkdir -p "$(dirname "$keystore")"
    keytool -genkeypair -keystore "$keystore" -storepass android -keypass android \
      -alias "$alias" -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null
  fi
  echo "package-apk: warning: ANDROID_KEYSTORE is not set; signing with the debug keystore." >&2
  echo "package-apk: warning: do not distribute this APK; updates need the same key." >&2
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

"$zipalign" -P 16 -f 4 "$unsigned" "$stage/aligned.apk"
"$apksigner" sign \
  --ks "$keystore" --ks-key-alias "$alias" \
  --ks-pass env:OAD_KS_PASS --key-pass env:OAD_KEY_PASS \
  --out "$stage/signed.apk" "$stage/aligned.apk"
"$apksigner" verify "$stage/signed.apk" || die "signature verification failed"

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$APK_NAME" "$DIST_DIR/$APK_NAME.sha256"
cp "$stage/signed.apk" "$DIST_DIR/$APK_NAME"
(cd "$DIST_DIR" && shasum -a 256 "$APK_NAME" > "$APK_NAME.sha256")

size="$(du -h "$DIST_DIR/$APK_NAME" | cut -f1)"
echo "package-apk: wrote mobile/$DIST_DIR/$APK_NAME ($size)"
echo "package-apk: wrote mobile/$DIST_DIR/$APK_NAME.sha256"
