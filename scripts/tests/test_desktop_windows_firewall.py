"""The Windows MSI adds a private-network firewall rule for the sidecar.

Desktop "Network access" makes the bundled ``openagentd.exe`` listen on all
interfaces; without this rule Windows asks for an administrator on first use.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "desktop" / "src-tauri"
FRAGMENT = TAURI / "windows" / "firewall.wxs"


def _wix() -> dict:
    config = json.loads((TAURI / "tauri.conf.json").read_text())
    return config["bundle"]["windows"]["wix"]


def test_the_msi_includes_the_firewall_fragment() -> None:
    wix = _wix()
    assert "windows/firewall.wxs" in wix["fragmentPaths"]
    assert "SidecarFirewall" in wix["componentGroupRefs"]
    for path in wix["fragmentPaths"]:
        assert (TAURI / path).is_file(), path


def test_the_rule_targets_the_bundled_sidecar_on_private_networks_only() -> None:
    text = FRAGMENT.read_text()
    # Tauri's bundler enables a WiX extension only when its namespace appears.
    assert '"http://schemas.microsoft.com/wix/FirewallExtension"' in text
    assert '<ComponentGroup Id="SidecarFirewall">' in text
    assert 'Profile="private"' in text
    assert 'Protocol="tcp"' in text
    assert 'IgnoreFailure="yes"' in text
    program = re.search(r'Program="([^"]+)"', text)
    assert program is not None
    # Resources map ../sidecar-bundle/ to sidecar/ and the sidecar lives in bin/
    # (desktop/Makefile, release-desktop.yml, sidecar.rs resolve_backend_bin).
    assert program.group(1) == r"[INSTALLDIR]sidecar\bin\openagentd.exe"
    resources = json.loads((TAURI / "tauri.conf.json").read_text())["bundle"]["resources"]
    assert resources["../sidecar-bundle/"] == "sidecar/"
    assert 'join("bin").join("openagentd.exe")' in (TAURI / "src" / "sidecar.rs").read_text()
