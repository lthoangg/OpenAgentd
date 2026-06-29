"""Regression tests for security-patched dependency floors.

These tests guard the lockfiles against accidentally reintroducing versions that
are known to be vulnerable or incompatible with the current build stack.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


PACKAGE_FLOORS = {
    "cryptography": "48.0.1",
    "idna": "3.15",
    "lxml": "6.1.0",
    "mako": "1.3.12",
    "pygments": "2.20.0",
    "pyjwt": "2.13.0",
    "starlette": "1.3.1",
    "urllib3": "2.7.0",
}


def _version_tuple(version: str) -> tuple[int, ...]:
    """Return numeric release components for simple pinned dependency versions."""
    return tuple(int(part) for part in version.split(".") if part.isdigit())


def test_python_lock_keeps_security_patched_dependency_floors() -> None:
    """Direct/transitive Python deps stay at or above patched advisory versions."""
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    versions = {
        package["name"].lower(): package["version"] for package in lock["package"]
    }

    missing = sorted(set(PACKAGE_FLOORS) - set(versions))
    assert missing == []

    below_floor = {
        name: versions[name]
        for name, floor in PACKAGE_FLOORS.items()
        if _version_tuple(versions[name]) < _version_tuple(floor)
    }
    assert below_floor == {}


def test_web_lock_pins_patched_mcp_sdk_without_reintroducing_react_plugin_break() -> (
    None
):
    """MCP SDK is patched while Vite React plugin remains on the compatible major."""
    package_json = json.loads((ROOT / "web/package.json").read_text())
    mcp_sdk_version = package_json["dependencies"]["@modelcontextprotocol/sdk"]
    assert _version_tuple(mcp_sdk_version) >= _version_tuple("1.26.0")
    assert _version_tuple(
        package_json["devDependencies"]["@vitejs/plugin-react"]
    ) >= _version_tuple("6.0.3")

    lock_text = (ROOT / "web/bun.lock").read_text()
    assert f'"@modelcontextprotocol/sdk": "{mcp_sdk_version}"' in lock_text
    assert f'"@modelcontextprotocol/sdk@{mcp_sdk_version}"' in lock_text


def test_desktop_lock_keeps_patched_tar_version() -> None:
    """Desktop updater archive handling uses the patched tar release."""
    lock_text = (ROOT / "desktop/src-tauri/Cargo.lock").read_text()
    match = re.search(r'name = "tar"\nversion = "(?P<version>[^"]+)"', lock_text)

    assert match is not None
    assert _version_tuple(match.group("version")) >= _version_tuple("0.4.46")
