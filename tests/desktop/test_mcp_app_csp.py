from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _csp(path: str) -> dict[str, str]:
    config = json.loads((ROOT / path).read_text())
    return config["app"]["security"]["csp"]


def test_desktop_csp_allows_general_mcp_app_resources_in_production() -> None:
    csp = _csp("desktop/src-tauri/tauri.conf.json")

    assert "http:" in csp["default-src"]
    assert "https:" in csp["default-src"]
    assert "http:" in csp["connect-src"]
    assert "https:" in csp["connect-src"]
    assert "wss:" in csp["connect-src"]
    assert "blob:" in csp["script-src"]
    assert "data:" in csp["script-src"]
    assert "http:" in csp["script-src"]
    assert "https:" in csp["script-src"]
    assert "'unsafe-eval'" in csp["script-src"]
    assert "http:" in csp["style-src"]
    assert "https:" in csp["style-src"]
    assert "http:" in csp["font-src"]
    assert "https:" in csp["font-src"]
    assert "blob:" in csp["frame-src"]
    assert "data:" in csp["frame-src"]
    assert "http:" in csp["frame-src"]
    assert "https:" in csp["frame-src"]


def test_mobile_csp_allows_general_mcp_app_frames_in_production() -> None:
    csp = _csp("mobile/src-tauri/tauri.conf.json")

    assert "blob:" in csp["frame-src"]
    assert "data:" in csp["frame-src"]
    assert "http:" in csp["frame-src"]
    assert "https:" in csp["frame-src"]
    assert "blob:" in csp["script-src"]
    assert "'unsafe-eval'" in csp["script-src"]
    assert "https:" in csp["script-src"]
    assert "https:" in csp["connect-src"]
