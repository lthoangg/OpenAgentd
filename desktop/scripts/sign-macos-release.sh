#!/usr/bin/env bash
# Sign the macOS release once, for every artifact: the updater archive
# (.app.tar.gz + .sig) and the DMG carry the same app with the same signature.
#
# Usage: sign-macos-release.sh <bundle dir> <bundle identifier>
#   <bundle dir> is Tauri's ``target/<triple>/release/bundle`` with ``macos/``
#   (OpenAgentd.app and its .app.tar.gz) and, optionally, ``dmg/``.
#
# Tauri signs the app ad hoc, which pins the designated requirement to the
# build's cdhash. macOS keeps privacy grants (e.g. Documents folder access)
# for the designated requirement, so the app is re-signed ad hoc with
# ``designated => identifier "<id>"``, which stays the same across releases.
# Nothing re-signs it after this: the in-app updater installs the archive
# unchanged (since tauri-plugin-updater 2.14.0 ``install()`` verifies the
# bytes against the .sig), and install.sh and the Homebrew cask only strip
# the quarantine flag. Installed v3.19-v3.21 apps still re-sign an update
# before installing it unless it already has this requirement, so it must
# stay identifier-only.
#
# A bundle signed by Apple (Developer ID) is left alone. The .sig is
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
[ -f "$archive" ] || fail "missing updater archive: $archive"

stable="designated => identifier \"$bundle_id\""
# An implicit (ad hoc) requirement prints as "# designated => cdhash ...".
designated() { codesign -d -r - "$1" 2>&1 | sed -n 's/^# //; /^designated =>/{p;q;}'; }

# Fail unless the app at $1 verifies strictly and has the expected requirement.
check_app() {
  codesign --verify --deep --strict "$1" || fail "signature does not verify: $1"
  local current
  current=$(designated "$1")
  [ "$current" = "$expected" ] || fail "unexpected designated requirement for $1: $current"
}

current=$(designated "$app")
if [[ "$current" == *"anchor apple"* ]]; then
  log "$name is signed by Apple ($current); leaving it unchanged"
  exit 0
fi
expected=$stable

# ── Sign the app ─────────────────────────────────────────────────────────────
entitlements="$app/Contents/Resources/entitlements.plist"
[ -f "$entitlements" ] || fail "missing $entitlements"
if [ "$current" != "$stable" ]; then
  log "re-signing $name ad hoc (was: ${current:-unsigned})"
  codesign --force --deep --options runtime --sign - \
    "-r=$stable" --entitlements "$entitlements" "$app"
fi
check_app "$app"

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
elif $had_sig; then
  fail "the archive had an updater signature but no TAURI_SIGNING_PRIVATE_KEY is set to re-sign it"
fi

# ── DMG ──────────────────────────────────────────────────────────────────────
# Swap the signed app into Tauri's DMG, keeping its layout (Applications link,
# volume icon): convert to read-write, replace the app, convert back.
dmgs=()
[ -d "$bundle_dir/dmg" ] && dmgs=("$bundle_dir"/dmg/*.dmg)
if [ ${#dmgs[@]} -eq 0 ] || [ ! -f "${dmgs[0]}" ]; then
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
