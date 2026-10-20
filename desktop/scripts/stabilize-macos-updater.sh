#!/usr/bin/env bash
# Give the macOS updater archive a stable code signature, then re-sign it for
# the Tauri updater.
#
# Usage: stabilize-macos-updater.sh <bundle/macos dir> <bundle identifier>
#
# Tauri signs the release bundle ad hoc, which pins the designated requirement
# to the build's cdhash. Installed apps re-sign such a bundle with the
# identifier-only requirement before installing it, which changes the archive
# bytes. Since tauri-plugin-updater 2.14.0, ``Update::install`` verifies the
# bytes it is given, so those re-signed bytes fail with "The signature
# verification failed". An archive whose bundle already carries
# ``designated => identifier "<id>"`` is installed unchanged, so its updater
# signature still verifies.
#
# A bundle signed by Apple (Developer ID) is left alone. Otherwise the .app is
# re-signed ad hoc with the identifier-only requirement (the same flags as
# ``desktop/scripts/install.sh`` and the in-app updater), the .app.tar.gz is
# rebuilt from it, and the .sig is regenerated with ``cargo tauri signer
# sign`` (TAURI_SIGNING_PRIVATE_KEY / _PASSWORD from the environment). A stale
# .sig is never left next to a rebuilt archive.
set -euo pipefail

fail() { echo "stabilize-macos-updater: $*" >&2; exit 1; }
log() { echo "stabilize-macos-updater: $*"; }

[ $# -eq 2 ] || fail "usage: $0 <bundle/macos dir> <bundle identifier>"
dir=$1 bundle_id=$2
[ -d "$dir" ] || fail "no such directory: $dir"

apps=("$dir"/*.app)
[ ${#apps[@]} -eq 1 ] && [ -d "${apps[0]}" ] || fail "expected one .app in $dir"
app=${apps[0]}
name=$(basename "$app")
archive="$dir/$name.tar.gz"
[ -f "$archive" ] || fail "missing updater archive: $archive"

stable="designated => identifier \"$bundle_id\""
# An implicit (ad hoc) requirement prints as "# designated => cdhash ...".
designated() { codesign -d -r - "$1" 2>&1 | sed -n 's/^# //; /^designated =>/{p;q;}'; }

current=$(designated "$app")
if [[ "$current" == *"anchor apple"* ]]; then
  log "$name is signed by Apple ($current); leaving it unchanged"
  exit 0
fi

entitlements="$app/Contents/Resources/entitlements.plist"
[ -f "$entitlements" ] || fail "missing $entitlements"

if [ "$current" != "$stable" ]; then
  log "re-signing $name ad hoc (was: ${current:-unsigned})"
  codesign --force --deep --options runtime --sign - \
    "-r=$stable" --entitlements "$entitlements" "$app"
fi
codesign --verify --deep --strict "$app"
current=$(designated "$app")
[ "$current" = "$stable" ] || fail "unexpected designated requirement: $current"

# Rebuild the archive with the bundle at its root, as Tauri does. No
# AppleDouble (._*) files or extended attributes: the updater extracts every
# entry into the bundle.
had_sig=false
[ -f "$archive.sig" ] && had_sig=true
rm -f "$archive" "$archive.sig"
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$archive" -C "$dir" "$name"
if tar -tzf "$archive" | grep -q '/\._\|^\._'; then
  fail "archive contains AppleDouble files"
fi
log "rebuilt $archive"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  cargo tauri signer sign "$archive" >/dev/null
  [ -f "$archive.sig" ] || fail "cargo tauri signer did not write $archive.sig"
  log "signed $archive"
elif $had_sig; then
  fail "the archive had an updater signature but no TAURI_SIGNING_PRIVATE_KEY is set to re-sign it"
fi
