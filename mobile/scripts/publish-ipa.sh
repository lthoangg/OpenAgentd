#!/usr/bin/env bash
#
# Upload the packaged IPA to the versioned GitHub release and refresh the
# SideStore / AltStore source feed on the rolling `latest-ios` release.
#
# Run after `release.yml` has created `v<version>` and the release notes
# are applied (see the oad/release skill). HEAD must be the tagged commit so
# the IPA matches the published source.
#
# DRY_RUN=1 runs every check and writes dist/source.json, but only prints
# the `gh` upload commands.

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="lthoangg/openagentd"
ROLLING_TAG="latest-ios"
VERSION="$(../scripts/release_version.sh)"
TAG="v$VERSION"
DIST_DIR="dist"
IPA_NAME="OpenAgentd_${VERSION}_iOS.ipa"
IPA="$DIST_DIR/$IPA_NAME"
SOURCE="$DIST_DIR/source.json"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$IPA_NAME"
DRY_RUN="${DRY_RUN:-0}"

die() {
  echo "publish-ipa: error: $*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'publish-ipa: [dry-run]'
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
    echo "publish-ipa: upload of $file failed (attempt $attempt), retrying in 5s..." >&2
    sleep 5
  done
  die "failed to upload $file after 5 attempts"
}

command -v gh >/dev/null 2>&1 || die "GitHub CLI 'gh' is required"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
git fetch --tags --quiet origin
tag_commit="$(git rev-parse --verify --quiet "$TAG^{commit}")" || die "tag $TAG does not exist (run release.yml first)"
if [ "$(git rev-parse HEAD)" != "$tag_commit" ]; then
  # ALLOW_AFTER_TAG=1: ship a build fix made after tagging. HEAD must still
  # descend from the tag, and the release notes must say the IPA is newer.
  if [ "${ALLOW_AFTER_TAG:-0}" = "1" ] && git merge-base --is-ancestor "$tag_commit" HEAD; then
    echo "publish-ipa: warning: HEAD is ahead of $TAG; the IPA is built from $(git rev-parse --short HEAD)" >&2
  else
    die "HEAD is not $TAG; check out the tagged commit and rebuild"
  fi
fi
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || die "GitHub release $TAG does not exist"
[ -f "$IPA" ] && [ -f "$IPA.sha256" ] || die "$IPA or its .sha256 is missing (run 'make ios-ipa')"
(cd "$DIST_DIR" && shasum -a 256 -c "$IPA_NAME.sha256" >/dev/null) || die "$IPA does not match its .sha256"

upload "$TAG" "$IPA"
upload "$TAG" "$IPA.sha256"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh release download "$ROLLING_TAG" --repo "$REPO" --pattern source.json --dir "$work" >/dev/null 2>&1 \
  || echo "publish-ipa: no previous source.json on $ROLLING_TAG; starting a new feed"
gh release view "$TAG" --repo "$REPO" --json body -q .body > "$work/notes.md"

python3 ../scripts/make_sidestore_source.py \
  --ipa "$IPA" \
  --version "$VERSION" \
  --download-url "$DOWNLOAD_URL" \
  --notes-file "$work/notes.md" \
  --previous "$work/source.json" \
  --entitlement com.apple.security.application-groups \
  --out "$SOURCE"

# The rolling release stays a pre-release so it never becomes
# `releases/latest`, which the desktop and CLI installers resolve.
NOTES="Auto-generated SideStore/AltStore source for OpenAgentd iOS $VERSION. Add https://github.com/$REPO/releases/download/$ROLLING_TAG/source.json as a source; download the IPA from the versioned release, not from here."
TITLE="iOS sideload source (rolling)"
if gh release view "$ROLLING_TAG" --repo "$REPO" >/dev/null 2>&1; then
  upload "$ROLLING_TAG" "$SOURCE"
  run gh release edit "$ROLLING_TAG" --repo "$REPO" \
    --title "$TITLE" --notes "$NOTES" --prerelease --draft=false
else
  run gh release create "$ROLLING_TAG" "$SOURCE" --repo "$REPO" \
    --title "$TITLE" --notes "$NOTES" --prerelease --latest=false --target main
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "publish-ipa: dry run complete; review mobile/$SOURCE"
else
  echo "publish-ipa: published $IPA_NAME to $TAG and source.json to $ROLLING_TAG"
fi
