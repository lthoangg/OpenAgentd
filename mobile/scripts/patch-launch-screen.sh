#!/usr/bin/env bash
# Recolor the generated iOS launch screen from the system default (white
# in light mode, black in dark mode) to the app's paper tones, so launch
# hands off to the app with no flash in either appearance. The tones match
# index.html's pre-paint CSS: #FAF6EC in light mode, #15110D in dark mode.
#
# A storyboard colour is a static value, so the dark variant has to come
# from a named colour in the asset catalog (LaunchBackground.colorset),
# which iOS resolves per appearance at launch.
#
# `cargo tauri ios init` regenerates `src-tauri/gen/apple/` from a
# template on every run, so this can't be a one-time edit — it must be
# re-applied after every `ios-init` (see mobile/Makefile). It is safe to
# run more than once.
set -euo pipefail

cd "$(dirname "$0")/.."

storyboards=$(find src-tauri/gen/apple -name 'LaunchScreen.storyboard' 2>/dev/null || true)

if [ -z "$storyboards" ]; then
  echo "patch-launch-screen: no LaunchScreen.storyboard found under src-tauri/gen/apple — skipping (run after 'cargo tauri ios init')" >&2
  exit 0
fi

STORYBOARDS="$storyboards" python3 - <<'PY'
import json
import os
import re
import sys
from pathlib import Path

NAME = "LaunchBackground"
# sRGB components of #FAF6EC (paper) and #15110D (dark paper).
LIGHT = ("0.980392157", "0.964705882", "0.925490196")
DARK = ("0.082352941", "0.066666667", "0.050980392")


def colorset_entry(rgb, dark):
    red, green, blue = rgb
    entry = {
        "color": {
            "color-space": "srgb",
            "components": {"alpha": "1.000", "blue": blue, "green": green, "red": red},
        },
        "idiom": "universal",
    }
    if dark:
        entry = {"appearances": [{"appearance": "luminosity", "value": "dark"}], **entry}
    return entry


colorset = {
    "colors": [colorset_entry(LIGHT, dark=False), colorset_entry(DARK, dark=True)],
    "info": {"author": "xcode", "version": 1},
}

# A storyboard's own background line, whether it is the template's system
# colour, the old light-only custom colour, or an earlier run of this script.
BACKGROUND = re.compile(r'<color key="backgroundColor" [^>]*/>')
NAMED_BACKGROUND = f'<color key="backgroundColor" name="{NAME}"/>'
CAPABILITY = '<capability name="Named colors" minToolsVersion="9.0"/>'
# The fallback Interface Builder shows; at runtime iOS reads the asset catalog.
NAMED_COLOR = (
    f'        <namedColor name="{NAME}">\n'
    f'            <color red="{LIGHT[0]}" green="{LIGHT[1]}" blue="{LIGHT[2]}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>\n'
    f"        </namedColor>\n"
)

for line in os.environ["STORYBOARDS"].splitlines():
    storyboard = Path(line)
    text = storyboard.read_text()
    patched, count = BACKGROUND.subn(NAMED_BACKGROUND, text, count=1)
    if count == 0 or "</dependencies>" not in patched or "</resources>" not in patched:
        print(
            f"patch-launch-screen: {storyboard} has no background colour, dependencies or resources "
            "to patch — Tauri's template may have changed, check manually",
            file=sys.stderr,
        )
        continue
    if CAPABILITY not in patched:
        patched = patched.replace("    </dependencies>", f"        {CAPABILITY}\n    </dependencies>", 1)
    if f'<namedColor name="{NAME}">' not in patched:
        patched = patched.replace("    </resources>", f"{NAMED_COLOR}    </resources>", 1)
    storyboard.write_text(patched)

    catalog = storyboard.parent / "Assets.xcassets"
    target = catalog / f"{NAME}.colorset"
    target.mkdir(parents=True, exist_ok=True)
    (target / "Contents.json").write_text(json.dumps(colorset, indent=2) + "\n")
    print(f"patch-launch-screen: {storyboard} now uses {NAME} (paper in light mode, dark paper in dark mode)")
PY
