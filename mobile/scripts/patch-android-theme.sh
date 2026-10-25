#!/usr/bin/env bash
# Paint the generated Android app's window and Android 12+ splash screen in
# the app's paper tones, so launch hands off to the app with no flash in
# either appearance. The tones match index.html's pre-paint CSS and the iOS
# launch screen (patch-launch-screen.sh): #FAF6EC in light mode, #15110D in
# dark mode. Android picks values-night/ in dark mode.
#
# `cargo tauri android init` regenerates `src-tauri/gen/android/` from a
# template, so this must be re-applied after every `android-init` (see
# mobile/Makefile). It is safe to run more than once.
set -euo pipefail

cd "$(dirname "$0")/.."

res=src-tauri/gen/android/app/src/main/res

if [ ! -d "$res" ]; then
  echo "patch-android-theme: no $res — skipping (run after 'cargo tauri android init')" >&2
  exit 0
fi

RES="$res" python3 - <<'PY'
import os
import re
import sys
from pathlib import Path

NAME = "openagentd_launch_background"
TONES = {"values": "#FFFAF6EC", "values-night": "#FF15110D"}
ITEMS = (
    f'        <item name="android:windowBackground">@color/{NAME}</item>\n'
    f'        <item name="android:windowSplashScreenBackground" tools:targetApi="31">@color/{NAME}</item>\n'
)
# Lines an earlier run of this script added.
EARLIER = re.compile(rf'[ \t]*<item name="android:window(Background|SplashScreenBackground)"[^>]*>@color/{NAME}</item>\n')
TOOLS = 'xmlns:tools="http://schemas.android.com/tools"'

res = Path(os.environ["RES"])
for variant, tone in TONES.items():
    themes = res / variant / "themes.xml"
    if not themes.exists():
        print(f"patch-android-theme: {themes} is missing — Tauri's template may have changed, check manually", file=sys.stderr)
        continue
    text = EARLIER.sub("", themes.read_text())
    if "</style>" not in text or TOOLS not in text:
        print(f"patch-android-theme: {themes} has no style or tools namespace to patch — check manually", file=sys.stderr)
        continue
    themes.write_text(text.replace("    </style>", f"{ITEMS}    </style>", 1))
    (res / variant / "openagentd_launch.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="{NAME}">{tone}</color>\n'
        "</resources>\n"
    )
    print(f"patch-android-theme: {themes} now paints {tone[3:]} behind the app and its splash screen")
PY
