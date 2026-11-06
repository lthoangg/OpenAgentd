#!/usr/bin/env bash
#
# Sign an unsigned release archive for App Store Connect / TestFlight and
# package it as an IPA.
#
# Usage: sign-ipa-appstore.sh <OpenAgentd.app from the xcarchive> <out.ipa>
#
# Environment:
#   IOS_SIGNING_IDENTITY     keychain identity (default "Apple Distribution")
#   IOS_PROFILE_APP_PATH     App Store profile for the app bundle id
#   IOS_PROFILE_WIDGET_PATH  App Store profile for the widget extension
#   IOS_BUILD_NUMBER         CFBundleVersion for this upload (must grow
#                            for every upload; CI passes the run number)
#
# Release CI archives the app with code signing disabled (the build job has
# no certificate), so this script is the only place the app is signed:
# nested frameworks first, then the widget extension and the app, each with
# the entitlements from its own provisioning profile (application
# identifier, team, App Group, beta-reports-active) and the profile
# embedded. The never-loaded Rust static library is dropped, as
# package-ipa.sh does.

set -euo pipefail

die() { echo "sign-ipa-appstore: error: $*" >&2; exit 1; }
log() { echo "sign-ipa-appstore: $*"; }

[ $# -eq 2 ] || die "usage: $0 <OpenAgentd.app> <out.ipa>"
src_app=$1 out=$2
identity=${IOS_SIGNING_IDENTITY:-Apple Distribution}
app_profile=${IOS_PROFILE_APP_PATH:?IOS_PROFILE_APP_PATH is required}
widget_profile=${IOS_PROFILE_WIDGET_PATH:?IOS_PROFILE_WIDGET_PATH is required}
build_number=${IOS_BUILD_NUMBER:?IOS_BUILD_NUMBER is required}
[ -d "$src_app" ] || die "no app at $src_app"
[[ "$build_number" =~ ^[0-9]+$ ]] || die "IOS_BUILD_NUMBER must be an integer: $build_number"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app="$stage/Payload/$(basename "$src_app")"
mkdir -p "$stage/Payload"
ditto "$src_app" "$app"
rm -rf "$app/_CodeSignature" "$app/embedded.mobileprovision"
find "$app" -name '*.a' -type f -delete

# Entitlements of a profile, with the keychain group narrowed from the
# profile's "TEAM.*" wildcard to the bundle's own application identifier,
# as Xcode does.
profile_entitlements() {
  local profile=$1 out=$2 plist="$stage/profile.plist"
  security cms -D -i "$profile" > "$plist" || die "cannot decode $profile"
  plutil -extract Entitlements xml1 -o "$out" "$plist"
  local app_id
  app_id=$(plutil -extract application-identifier raw "$out")
  plutil -replace keychain-access-groups -json "[\"$app_id\"]" "$out"
  [ "$(plutil -extract get-task-allow raw "$out" 2>/dev/null || echo false)" = "false" ] \
    || die "$profile is not a distribution profile (get-task-allow is true)"
}

# Check that a profile matches a bundle, then embed it and sign the bundle.
sign_bundle() {
  local bundle=$1 profile=$2 ents="$stage/$(basename "$1").entitlements"
  profile_entitlements "$profile" "$ents"
  local bundle_id app_id
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Info.plist")
  app_id=$(plutil -extract application-identifier raw "$ents")
  [ "${app_id#*.}" = "$bundle_id" ] \
    || die "$(basename "$profile") is for $app_id, not $bundle_id"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$bundle/Info.plist"
  rm -rf "$bundle/_CodeSignature"
  cp "$profile" "$bundle/embedded.mobileprovision"
  codesign --force --timestamp --sign "$identity" --entitlements "$ents" "$bundle"
  log "signed $(basename "$bundle") ($bundle_id)"
}

if [ -d "$app/Frameworks" ]; then
  while IFS= read -r -d '' fw; do
    codesign --force --timestamp --sign "$identity" "$fw"
  done < <(find "$app/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) -print0)
fi
appexes=()
if [ -d "$app/PlugIns" ]; then
  while IFS= read -r -d '' x; do appexes+=("$x"); done \
    < <(find "$app/PlugIns" -maxdepth 1 -name '*.appex' -print0)
fi
[ ${#appexes[@]} -eq 1 ] || die "expected one app extension (the widget), found ${#appexes[@]}"
sign_bundle "${appexes[0]}" "$widget_profile"
sign_bundle "$app" "$app_profile"

codesign --verify --deep --strict "$app" || die "signature verification failed"
for b in "$app" "${appexes[0]}"; do
  codesign -d --entitlements - --xml "$b" 2>/dev/null | plutil -convert json -o - - \
    | python3 -c 'import json,sys; e=json.load(sys.stdin); assert e.get("com.apple.security.application-groups"), "no App Group"' \
    || die "$(basename "$b") is missing the App Group entitlement"
done

mkdir -p "$(dirname "$out")"
rm -f "$out"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
(cd "$stage" && zip -qry -X "$out_abs" Payload)
log "wrote $out (build $build_number)"
