"""mobile/scripts/patch-xcode-project.sh appends the libapp.a post-processing
to the Rust build phase on the same shell line."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "mobile" / "scripts" / "patch-xcode-project.sh"
HOOK = '&& \\"$SRCROOT/../../../scripts/postprocess-libapp.sh\\"'


@pytest.mark.parametrize("ending", ["", "\\n", "\\n\\n"])
def test_hook_joins_the_xcode_script_line(tmp_path: Path, ending: str):
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)
    pbxproj = mobile / "src-tauri" / "gen" / "apple" / "openagentd-mobile.xcodeproj" / "project.pbxproj"
    pbxproj.parent.mkdir(parents=True)
    pbxproj.write_text(f'shellScript = "cargo tauri ios xcode-script -v ${{ARCHS:?}}{ending}";\n')

    subprocess.run(["bash", str(mobile / "scripts" / SCRIPT.name)], check=True, capture_output=True)

    patched = pbxproj.read_text()
    assert f"${{ARCHS:?}} {HOOK}{ending}\";" in patched
