#!/usr/bin/env bash
#
# Upload the signed APK to the versioned GitHub release, and the in-app
# update feed (latest.json) to the rolling `latest-android` release.
#
# Run after `release.yml` has created `v<version>` (see the oad/release
# skill). HEAD must be the tagged commit so the APK matches the published
# source, and the APK must carry the release signing key: Android only
# installs an update signed with the same key as the installed app, so a
# debug-signed upload would strand every user on their next update.
#
# DRY_RUN=1 runs every check (a debug signature only warns) and prints the
# `gh` upload commands instead of running them. Before `release.yml` has
# created the tag, it skips the tag and release checks with a warning, so the
# build can be checked while the version PR's CI runs.

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="lthoangg/openagentd"
VERSION="$(../scripts/release_version.sh)"
TAG="v$VERSION"
ROLLING_TAG="latest-android"
DIST_DIR="dist"
APK_NAME="OpenAgentd_${VERSION}_Android.apk"
APK="$DIST_DIR/$APK_NAME"
MANIFEST="$DIST_DIR/latest.json"
DRY_RUN="${DRY_RUN:-0}"

die() {
  echo "publish-apk: error: $*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'publish-apk: [dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

upload() {
  local tag="$1" file="$2"
  for attempt in 1 2 3 4 5; do
    if run gh release upload "$tag" "$file" --repo "$REPO" --clobber; then
      return 0
    fi
    echo "publish-apk: upload of $file failed (attempt $attempt), retrying in 5s..." >&2
    sleep 5
  done
  die "failed to upload $file after 5 attempts"
}

: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
command -v gh >/dev/null 2>&1 || die "GitHub CLI 'gh' is required"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
git fetch --tags --quiet origin
if tag_commit="$(git rev-parse --verify --quiet "$TAG^{commit}")"; then
  [ "$(git rev-parse HEAD)" = "$tag_commit" ] || die "HEAD is not $TAG; check out the tagged commit and rebuild"
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || die "GitHub release $TAG does not exist"
  released=1
elif [ "$DRY_RUN" = "1" ]; then
  echo "publish-apk: warning: tag $TAG does not exist yet; skipping the tag and release checks" >&2
  released=0
else
  die "tag $TAG does not exist (run release.yml first)"
fi
[ -f "$APK" ] && [ -f "$APK.sha256" ] || die "$APK or its .sha256 is missing (run 'make android-apk')"
(cd "$DIST_DIR" && shasum -a 256 -c "$APK_NAME.sha256" >/dev/null) || die "$APK does not match its .sha256"

build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)"
[ -n "$build_tools" ] || die "no build-tools under $ANDROID_HOME/build-tools"
signer="$("$build_tools/apksigner" verify --print-certs "$APK")" || die "$APK signature does not verify"
if printf '%s\n' "$signer" | grep -q 'CN=Android Debug'; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "publish-apk: warning: $APK is debug-signed; a real run refuses it" >&2
  else
    die "$APK is debug-signed; rebuild with ANDROID_KEYSTORE set to the release keystore"
  fi
fi

upload "$TAG" "$APK"
upload "$TAG" "$APK.sha256"

# The in-app update feed. Written after the APK upload so the app never sees
# a version whose APK is not downloadable yet.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "$released" = "1" ]; then
  gh release view "$TAG" --repo "$REPO" --json body -q .body > "$work/notes.md"
else
  echo "Release notes for $TAG (not released yet)." > "$work/notes.md"
fi
python3 ../scripts/make_android_update_manifest.py \
  --apk "$APK" \
  --version "$VERSION" \
  --download-url "https://github.com/$REPO/releases/download/$TAG/$APK_NAME" \
  --notes-file "$work/notes.md" \
  --out "$MANIFEST"

# The rolling release stays a pre-release so it never becomes
# `releases/latest`, which the desktop and CLI installers resolve.
NOTES="In-app update feed for OpenAgentd Android $VERSION. Download the APK from the versioned release, not from here."
TITLE="Android update feed (rolling)"
if gh release view "$ROLLING_TAG" --repo "$REPO" >/dev/null 2>&1; then
  upload "$ROLLING_TAG" "$MANIFEST"
  run gh release edit "$ROLLING_TAG" --repo "$REPO" \
    --title "$TITLE" --notes "$NOTES" --prerelease --draft=false
else
  run gh release create "$ROLLING_TAG" "$MANIFEST" --repo "$REPO" \
    --title "$TITLE" --notes "$NOTES" --prerelease --latest=false --target main
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "publish-apk: dry run complete; review mobile/$MANIFEST"
else
  echo "publish-apk: published $APK_NAME to $TAG and latest.json to $ROLLING_TAG"
fi
