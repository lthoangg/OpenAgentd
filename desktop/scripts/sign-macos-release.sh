#!/usr/bin/env bash
# Sign the macOS release once, for every artifact: the updater archive
# (.app.tar.gz + .sig) and the DMG carry the same app with the same signature.
#
# Usage: sign-macos-release.sh <bundle dir> <bundle identifier>
#   <bundle dir> is Tauri's ``target/<triple>/release/bundle`` with ``macos/``
#   (OpenAgentd.app and, optionally, its .app.tar.gz) and, optionally, ``dmg/``.
#
# Two modes:
#
# * Developer ID (release CI): ``APPLE_SIGNING_IDENTITY`` names a
#   "Developer ID Application" identity in the keychain. Every nested Mach-O
#   (the ``agentd`` sidecar under Resources/) is signed first, then the app,
#   all with the hardened runtime and a secure timestamp; the designated
#   requirement is Apple's default (anchor apple generic + identifier + Team
#   ID), which stays the same across releases so macOS keeps privacy grants.
#   With App Store Connect API key credentials (``APPLE_API_KEY``,
#   ``APPLE_API_ISSUER``, ``APPLE_API_KEY_PATH``) the app is notarized and
#   stapled before it is archived, and the DMG is signed, notarized and
#   stapled after the swap, so both pass Gatekeeper offline.
#   ``REQUIRE_DEVELOPER_ID=1`` makes a missing identity or missing notary
#   credentials fatal, so CI can never ship an ad hoc release by accident.
#
# * Ad hoc (local builds, tests): no identity. The app is re-signed ad hoc
#   with ``designated => identifier "<id>"`` instead of Tauri's cdhash.
#
# Nothing re-signs the app after this: the in-app updater installs the
# archive unchanged (tauri-plugin-updater >= 2.14.0 verifies it against the
# .sig), and install.sh and the Homebrew cask only verify it. The .sig is
# regenerated with ``cargo tauri signer sign`` (TAURI_SIGNING_PRIVATE_KEY /
# _PASSWORD from the environment); a stale .sig is never shipped.
set -euo pipefail

fail() { echo "sign-macos-release: $*" >&2; exit 1; }
log() { echo "sign-macos-release: $*"; }

[ $# -eq 2 ] || fail "usage: $0 <bundle dir> <bundle identifier>"
bundle_dir=$1 bundle_id=$2
macos_dir="$bundle_dir/macos"
[ -d "$macos_dir" ] || fail "no such directory: $macos_dir"

apps=("$macos_dir"/*.app)
[ ${#apps[@]} -eq 1 ] && [ -d "${apps[0]}" ] || fail "expected one .app in $macos_dir"
app=${apps[0]}
name=$(basename "$app")
archive="$macos_dir/$name.tar.gz"

identity=${APPLE_SIGNING_IDENTITY:-}
require_devid=${REQUIRE_DEVELOPER_ID:-0}
do_notarize=false
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  do_notarize=true
fi
if [ "$require_devid" = "1" ]; then
  [ -n "$identity" ] || fail "REQUIRE_DEVELOPER_ID=1 but APPLE_SIGNING_IDENTITY is not set"
  $do_notarize || fail "REQUIRE_DEVELOPER_ID=1 but APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH are not all set"
fi
[ -z "$identity" ] && do_notarize=false

stable="designated => identifier \"$bundle_id\""
# An implicit requirement prints as "# designated => ...".
designated() { codesign -d -r - "$1" 2>&1 | sed -n 's/^# //; /^designated =>/{p;q;}'; }

# Fail unless the app at $1 verifies strictly and has the expected requirement.
check_app() {
  codesign --verify --deep --strict "$1" || fail "signature does not verify: $1"
  local current
  current=$(designated "$1")
  if [ -n "$identity" ]; then
    [[ "$current" == *"anchor apple generic"* && "$current" == *"identifier \"$bundle_id\""* ]] \
      || fail "unexpected designated requirement for $1: $current"
  else
    [ "$current" = "$stable" ] || fail "unexpected designated requirement for $1: $current"
  fi
}

# Submit $1 to Apple's notary service and wait; print the log on rejection.
notarize() {
  local file=$1 out id status
  log "notarizing $(basename "$file")"
  out=$(xcrun notarytool submit "$file" --wait --output-format json \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER") \
    || { echo "$out" >&2; fail "notarytool submit failed for $file"; }
  id=$(plutil -extract id raw - <<<"$out" 2>/dev/null || true)
  status=$(plutil -extract status raw - <<<"$out" 2>/dev/null || true)
  if [ "$status" != "Accepted" ]; then
    [ -n "$id" ] && xcrun notarytool log "$id" \
      --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" >&2 || true
    fail "notarization of $file returned '${status:-unknown}' (submission ${id:-?})"
  fi
  log "notarization Accepted ($id)"
}

# ── Sign the app ─────────────────────────────────────────────────────────────
entitlements="$app/Contents/Resources/entitlements.plist"
[ -f "$entitlements" ] || fail "missing $entitlements"
if [ -n "$identity" ]; then
  log "signing $name with $identity"
  main_exe="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
  # Inside-out: every nested Mach-O except the main executable, which is
  # signed as part of the bundle below.
  while IFS= read -r -d '' f; do
    [ "$f" = "$main_exe" ] && continue
    if file -b "$f" | grep -q 'Mach-O'; then
      log "  nested: ${f#"$app"/}"
      codesign --force --options runtime --timestamp --sign "$identity" "$f"
    fi
  done < <(find "$app/Contents" -type f -perm -u+x -print0)
  codesign --force --options runtime --timestamp --sign "$identity" \
    --entitlements "$entitlements" "$app"
else
  current=$(designated "$app")
  if [ "$current" != "$stable" ]; then
    log "re-signing $name ad hoc (was: ${current:-unsigned})"
    codesign --force --deep --options runtime --sign - \
      "-r=$stable" --entitlements "$entitlements" "$app"
  fi
fi
check_app "$app"

if $do_notarize; then
  zip="$(mktemp -d)/$name.zip"
  ditto -c -k --keepParent "$app" "$zip"
  notarize "$zip"
  rm -f "$zip"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute -vv "$app"
fi

# ── Updater archive ──────────────────────────────────────────────────────────
# Rebuilt with the bundle at its root, as Tauri does. No AppleDouble (._*)
# files or extended attributes: the updater extracts every entry into the
# bundle.
had_sig=false
[ -f "$archive.sig" ] && had_sig=true
rm -f "$archive" "$archive.sig"
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$archive" -C "$macos_dir" "$name"
if tar -tzf "$archive" | grep -q '/\._\|^\._'; then
  fail "archive contains AppleDouble files"
fi
unpacked=$(mktemp -d)
trap 'rm -rf "$unpacked"' EXIT
tar -xzf "$archive" -C "$unpacked"
check_app "$unpacked/$name"
log "rebuilt $archive"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  cargo tauri signer sign "$archive" >/dev/null
  [ -f "$archive.sig" ] || fail "cargo tauri signer did not write $archive.sig"
  log "signed $archive"
elif $had_sig || [ "$require_devid" = "1" ]; then
  fail "the archive needs an updater signature but no TAURI_SIGNING_PRIVATE_KEY is set"
fi

# ── DMG ──────────────────────────────────────────────────────────────────────
# Swap the signed app into Tauri's DMG, keeping its layout (Applications link,
# volume icon): convert to read-write, replace the app, convert back.
dmgs=()
[ -d "$bundle_dir/dmg" ] && dmgs=("$bundle_dir"/dmg/*.dmg)
if [ ${#dmgs[@]} -eq 0 ] || [ ! -f "${dmgs[0]}" ]; then
  [ "$require_devid" = "1" ] && fail "no DMG in $bundle_dir/dmg"
  log "no DMG in $bundle_dir/dmg; done"
  exit 0
fi
[ ${#dmgs[@]} -eq 1 ] || fail "expected one DMG in $bundle_dir/dmg"
dmg=${dmgs[0]}
work=$(mktemp -d)
trap 'hdiutil detach "$work/mnt" -quiet -force 2>/dev/null || true; rm -rf "$unpacked" "$work"' EXIT
hdiutil convert "$dmg" -quiet -format UDRW -o "$work/rw.dmg"
# Room for a signature that grew; UDZO compresses the free space away.
read -r _ sectors _ < <(hdiutil resize -limits "$work/rw.dmg")
hdiutil resize -quiet -sectors $((sectors + 131072)) "$work/rw.dmg"
mkdir "$work/mnt"
hdiutil attach "$work/rw.dmg" -quiet -nobrowse -noverify -noautoopen -mountpoint "$work/mnt"
[ -d "$work/mnt/$name" ] || fail "$dmg does not contain $name"
rm -rf "${work:?}/mnt/$name"
ditto "$app" "$work/mnt/$name"
check_app "$work/mnt/$name"
hdiutil detach "$work/mnt" -quiet
rm -f "$dmg"
hdiutil convert "$work/rw.dmg" -quiet -format UDZO -imagekey zlib-level=9 -o "$dmg"
log "rebuilt $dmg"

if [ -n "$identity" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  codesign --verify --strict "$dmg"
  log "signed $dmg"
fi
if $do_notarize; then
  notarize "$dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature -vv "$dmg"
fi
