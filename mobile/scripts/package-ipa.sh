#!/usr/bin/env bash
#
# Package the release xcarchive into a sideloadable IPA.
#
# `cargo tauri ios build --archive-only` signs with the maintainer's
# development team, so the archived app carries an embedded provisioning
# profile (which lists the maintainer's device UDIDs) and development
# entitlements such as get-task-allow. It also contains the Rust static
# library `libapp.a` (~185 MB), which the generated project embeds even
# though nothing loads it at runtime.
#
# SideStore, AltStore, Sideloadly and TrollStore re-sign every IPA with the
# installing user's identity, so the IPA ships ad-hoc signed with none of the
# above. Its only entitlement is the App Group the app shares with its
# home-screen widget extension: the sideloading tool registers that group
# for the user's account (renaming it, see ios-widget/Shared). The SideStore
# source feed lists the same entitlements; a mismatch makes SideStore refuse
# the install.
#
# Output: dist/OpenAgentd_<version>_iOS.ipa and its .sha256.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(../scripts/release_version.sh)"
APP_NAME="OpenAgentd.app"
ARCHIVE_APP="src-tauri/gen/apple/build/openagentd-mobile_iOS.xcarchive/Products/Applications/$APP_NAME"
DIST_DIR="dist"
IPA_NAME="OpenAgentd_${VERSION}_iOS.ipa"

die() {
  echo "package-ipa: error: $*" >&2
  exit 1
}

[ -d "$ARCHIVE_APP" ] || die "archived app not found at $ARCHIVE_APP (run 'make ios-ipa')"

built_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ARCHIVE_APP/Info.plist")"
[ "$built_version" = "$VERSION" ] \
  || die "archived app is version $built_version, release version is $VERSION (stale archive?)"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
app="$stage/Payload/$APP_NAME"
mkdir -p "$stage/Payload"
ditto "$ARCHIVE_APP" "$app"

# Strip the developer's provisioning profiles, the old signatures and the
# never-loaded static library before signing.
rm -rf "$app/embedded.mobileprovision" "$app/_CodeSignature"
find "$app/PlugIns" -maxdepth 2 \( -name embedded.mobileprovision -o -name _CodeSignature \) \
  -exec rm -rf {} + 2>/dev/null || true
find "$app" -name '*.a' -type f -delete

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
app_group="group.$bundle_id"
group_entitlements="$stage/app-group.entitlements"
cat > "$group_entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>$app_group</string>
  </array>
</dict>
</plist>
PLIST

# Sign nested code first, then the bundle: frameworks with no entitlements,
# the widget extension and the app with only the shared App Group.
if [ -d "$app/Frameworks" ]; then
  find "$app/Frameworks" \( -name '*.framework' -o -name '*.dylib' \) -maxdepth 1 -print0 \
    | xargs -0 -I{} codesign --force --sign - --timestamp=none {}
fi
extensions=()
if [ -d "$app/PlugIns" ]; then
  while IFS= read -r -d '' appex; do extensions+=("$appex"); done \
    < <(find "$app/PlugIns" -maxdepth 1 -name '*.appex' -print0)
fi
for appex in ${extensions[@]+"${extensions[@]}"}; do
  codesign --force --sign - --timestamp=none --entitlements "$group_entitlements" "$appex"
done
codesign --force --sign - --timestamp=none --entitlements "$group_entitlements" "$app"

codesign --verify --strict --deep "$app" || die "signature verification failed"
# The only entitlement left must be the App Group, on the app and every extension.
for bundle in "$app" ${extensions[@]+"${extensions[@]}"}; do
  signed="$(codesign -d --entitlements - --xml "$bundle" 2>/dev/null || true)"
  keys="$(printf '%s' "$signed" | plutil -convert json -o - - 2>/dev/null \
    | python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin))))' 2>/dev/null || true)"
  [ "$keys" = "com.apple.security.application-groups" ] \
    || die "$(basename "$bundle") has unexpected entitlements: ${keys:-none}"
  [ ! -e "$bundle/embedded.mobileprovision" ] || die "embedded.mobileprovision still present in $(basename "$bundle")"
done
[ -z "$(find "$app" -name '*.a' -type f -print -quit)" ] || die "static library still present"

mkdir -p "$DIST_DIR"
dist_abs="$(cd "$DIST_DIR" && pwd)"
rm -f "$DIST_DIR/$IPA_NAME" "$DIST_DIR/$IPA_NAME.sha256"
(cd "$stage" && zip -qry -X "$dist_abs/$IPA_NAME" Payload)
(cd "$DIST_DIR" && shasum -a 256 "$IPA_NAME" > "$IPA_NAME.sha256")

size="$(du -h "$DIST_DIR/$IPA_NAME" | cut -f1)"
echo "package-ipa: wrote mobile/$DIST_DIR/$IPA_NAME ($size)"
echo "package-ipa: wrote mobile/$DIST_DIR/$IPA_NAME.sha256"
