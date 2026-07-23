from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MOBILE_MAKEFILE = REPO_ROOT / "mobile" / "Makefile"
TAURI_CONFIG = REPO_ROOT / "mobile" / "src-tauri" / "tauri.conf.json"


def test_fast_device_install_uses_debug_archive_and_existing_installer_path():
    makefile = MOBILE_MAKEFILE.read_text()

    assert "ios-install-device-fast:" in makefile
    assert "cargo tauri ios build --debug --archive-only" in makefile
    assert "Products/Applications/OpenAgentd.app" in makefile


def test_ios_web_build_is_skipped_when_dist_is_fresh():
    makefile = MOBILE_MAKEFILE.read_text()
    config = json.loads(TAURI_CONFIG.read_text())

    assert "ios-web:" in makefile
    assert "find $(WEB_DIR)/src $(WEB_DIR)/public" in makefile
    assert "Web bundle is current; skipping build" in makefile
    assert config["build"]["beforeBuildCommand"] == {
        "cwd": "../..",
        "script": "make -C mobile ios-web",
    }
