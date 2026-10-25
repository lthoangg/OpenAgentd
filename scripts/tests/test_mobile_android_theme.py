from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "mobile" / "scripts" / "patch-android-theme.sh"

# What `cargo tauri android init` generates in values/ and values-night/.
THEMES = """<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- Base application theme. -->
    <style name="Theme.openagentd_mobile" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <!-- Customize your theme here. -->
    </style>
</resources>
"""


def _project(tmp_path: Path) -> Path:
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)
    res = mobile / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "res"
    for variant in ("values", "values-night"):
        (res / variant).mkdir(parents=True)
        (res / variant / "themes.xml").write_text(THEMES)
    return mobile


def _res(mobile: Path) -> Path:
    return mobile / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "res"


def _run(mobile: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(mobile / "scripts" / SCRIPT.name)],
        capture_output=True,
        text=True,
        check=True,
    )


def _color(mobile: Path, variant: str) -> str:
    text = (_res(mobile) / variant / "openagentd_launch.xml").read_text()
    match = re.search(r'<color name="openagentd_launch_background">(#[0-9A-F]{8})</color>', text)
    assert match, text
    return match.group(1)


def test_window_and_splash_are_paper_in_light_mode_and_ink_in_dark_mode(tmp_path: Path):
    mobile = _project(tmp_path)

    _run(mobile)

    # The same tones as index.html's pre-paint CSS and the iOS launch screen.
    assert _color(mobile, "values") == "#FFFAF6EC"
    assert _color(mobile, "values-night") == "#FF15110D"
    for variant in ("values", "values-night"):
        themes = (_res(mobile) / variant / "themes.xml").read_text()
        assert '<item name="android:windowBackground">@color/openagentd_launch_background</item>' in themes
        assert (
            '<item name="android:windowSplashScreenBackground" tools:targetApi="31">'
            "@color/openagentd_launch_background</item>"
        ) in themes
        # The items land inside the app theme, which keeps its DayNight parent.
        style = themes[themes.index("<style") : themes.index("</style>")]
        assert "windowBackground" in style
        assert 'parent="Theme.MaterialComponents.DayNight.NoActionBar"' in style


def test_android_theme_patch_can_run_twice(tmp_path: Path):
    mobile = _project(tmp_path)

    _run(mobile)
    first = (_res(mobile) / "values" / "themes.xml").read_text()
    _run(mobile)
    second = (_res(mobile) / "values" / "themes.xml").read_text()

    assert second == first
    assert second.count("android:windowBackground") == 1
    assert second.count("android:windowSplashScreenBackground") == 1


def test_android_theme_patch_skips_without_a_generated_project(tmp_path: Path):
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)

    result = _run(mobile)

    assert "skipping" in result.stderr


def test_android_theme_patch_is_executable():
    # mobile/Makefile runs it as ./scripts/patch-android-theme.sh.
    assert os.access(SCRIPT, os.X_OK)
