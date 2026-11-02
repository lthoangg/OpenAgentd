"""Android's system picker (pick_one) is drawn in the app's ink.

On the Android 15 emulator the dialog's Cancel button came out white on the
light dialog surface: the activity theme's accent leaked into the platform
alert dialog. The plugin has no Kotlin test harness, so this pins the
contract in the source; the result is checked on the emulator.
"""

from __future__ import annotations

import re
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[2] / "mobile" / "android-plugin" / "android" / "src" / "main"
SOURCE = PLUGIN / "java" / "ShellPlugin.kt"
STYLES = PLUGIN / "res" / "values" / "openagentd_dialog_styles.xml"
TOKENS = Path(__file__).resolve().parents[2] / "web" / "src" / "styles" / "tokens.css"


def _pick_one() -> str:
    source = SOURCE.read_text()
    start = source.index("fun pickOne(")
    return source[start : source.index("\n    }\n", start)]


def test_the_picker_uses_the_app_dialog_styles():
    pick = _pick_one()
    assert "R.style.OpenAgentdDialog_Dark" in pick
    assert "R.style.OpenAgentdDialog" in pick
    assert "Theme_DeviceDefault" not in pick


def test_cancel_is_coloured_explicitly():
    assert "getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(accent(dark))" in _pick_one()


def test_the_dialog_accent_is_the_web_accent():
    styles = STYLES.read_text()
    accents = re.findall(r"--color-accent:\s*#([0-9A-Fa-f]{6});", TOKENS.read_text())
    assert len(accents) == 2
    for accent in accents:
        assert f"#FF{accent.upper()}" in styles.upper()
