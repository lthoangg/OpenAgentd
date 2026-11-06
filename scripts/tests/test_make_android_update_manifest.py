"""Tests for ``scripts/make_android_update_manifest.py``."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "make_android_update_manifest.py"
spec = importlib.util.spec_from_file_location("make_android_update_manifest", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

URL = "https://github.com/lthoangg/openagentd/releases/download/v3.49.0/OpenAgentd_3.49.0_Android.apk"


def test_manifest_carries_version_url_and_apk_digest(tmp_path: Path):
    apk = tmp_path / "a.apk"
    apk.write_bytes(b"apk bytes")
    notes = tmp_path / "notes.md"
    notes.write_text("  Fixes.\n")
    out = tmp_path / "latest.json"

    assert mod.main([
        "--apk", str(apk), "--version", "3.49.0", "--download-url", URL,
        "--notes-file", str(notes), "--out", str(out),
    ]) == 0

    data = json.loads(out.read_text())
    assert data["version"] == "3.49.0"
    assert data["url"] == URL
    assert data["sha256"] == hashlib.sha256(b"apk bytes").hexdigest()
    assert data["size"] == len(b"apk bytes")
    assert data["notes"] == "Fixes."
    assert data["pub_date"].endswith("Z")


@pytest.mark.parametrize("version", ["v3.49.0", "3.49", "latest"])
def test_rejects_non_release_versions(tmp_path: Path, version: str):
    apk = tmp_path / "a.apk"
    apk.write_bytes(b"x")
    with pytest.raises(SystemExit):
        mod.build_manifest(apk=apk, version=version, url=URL, notes="", now=dt.datetime.now(dt.timezone.utc))


def test_rejects_plain_http_download(tmp_path: Path):
    apk = tmp_path / "a.apk"
    apk.write_bytes(b"x")
    with pytest.raises(SystemExit):
        mod.build_manifest(apk=apk, version="1.0.0", url="http://example.com/a.apk", notes="", now=dt.datetime.now(dt.timezone.utc))
