from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _csp(path: str) -> dict[str, str]:
    config = json.loads((ROOT / path).read_text())
    return config["app"]["security"]["csp"]


def test_desktop_csp_allows_mcp_app_blob_frames_and_excalidraw_modules() -> None:
    csp = _csp("desktop/src-tauri/tauri.conf.json")

    assert "blob:" in csp["frame-src"]
    assert "blob:" in csp["script-src"]
    assert "'unsafe-eval'" in csp["script-src"]
    assert "https://esm.sh" in csp["script-src"]
    assert "https://esm.sh" in csp["connect-src"]


def test_mobile_csp_allows_mcp_app_blob_frames_and_excalidraw_modules() -> None:
    csp = _csp("mobile/src-tauri/tauri.conf.json")

    assert "blob:" in csp["frame-src"]
    assert "blob:" in csp["script-src"]
    assert "'unsafe-eval'" in csp["script-src"]
    assert "https:" in csp["script-src"]
    assert "https:" in csp["connect-src"]
