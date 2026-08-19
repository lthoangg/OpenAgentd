#!/usr/bin/env bash
# Recolor the generated iOS launch screen from the system default
# (pure white / no dark variant) to the app's paper background, so the
# launch flash matches the rest of the boot surface (index.html
# pre-paint CSS, theme-init.js, Tauri window backgroundColor).
#
# `cargo tauri ios init` regenerates `src-tauri/gen/apple/` from a
# template on every run, so this can't be a one-time edit — it must be
# re-applied after every `ios-init` (see mobile/Makefile).
#
# Storyboard color is a static XML value (no media-query equivalent),
# so this intentionally uses the light-mode paper tone (#FAF6EC) as the
# canonical default per DESIGN.md, rather than trying to encode a dark
# variant.
set -euo pipefail

cd "$(dirname "$0")/.."

PAPER_RED="0.980392157"
PAPER_GREEN="0.964705882"
PAPER_BLUE="0.925490196"

storyboards=$(find src-tauri/gen/apple -name 'LaunchScreen.storyboard' 2>/dev/null || true)

if [ -z "$storyboards" ]; then
  echo "patch-launch-screen: no LaunchScreen.storyboard found under src-tauri/gen/apple — skipping (run after 'cargo tauri ios init')" >&2
  exit 0
fi

patched=0
while IFS= read -r storyboard; do
  if grep -q 'systemColor="systemBackgroundColor"' "$storyboard"; then
    ruby -0pi -e "gsub(/<color key=\"backgroundColor\" systemColor=\"systemBackgroundColor\"\/>/, '<color key=\"backgroundColor\" red=\"$PAPER_RED\" green=\"$PAPER_GREEN\" blue=\"$PAPER_BLUE\" alpha=\"1\" colorSpace=\"custom\" customColorSpace=\"sRGB\"/>')" "$storyboard"
    echo "patch-launch-screen: recolored $storyboard to paper background"
    patched=1
  fi
done <<< "$storyboards"

if [ "$patched" -eq 0 ]; then
  echo "patch-launch-screen: found LaunchScreen.storyboard but no systemBackgroundColor to replace — Tauri's template may have changed, check manually" >&2
fi
