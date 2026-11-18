from __future__ import annotations

import base64
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "gallery.py"
    spec = importlib.util.spec_from_file_location("gallery", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module()


def _doc(*entries):
    return {"version": 1, "entries": list(entries)}


def _entry(**over):
    e = {"type": "connector", "id": "docs", "name": "Docs", "description": "Free docs.", "url": "https://docs.example/mcp", "auth": "none"}
    e.update(over)
    return e


def test_the_published_list_is_valid_and_matches_the_shipped_copy():
    published = json.loads(mod.LIST.read_text())
    assert mod.validate(published) == []
    assert published == json.loads(mod.BUNDLED.read_text())


def test_a_valid_entry_passes():
    assert mod.validate(_doc(_entry(), _entry(id="gh", auth={"header": "Authorization", "template": "Bearer {key}", "key_url": "https://x.example"}))) == []


@pytest.mark.parametrize(
    "over, problem",
    [
        ({"url": "http://docs.example/mcp"}, "url must be https"),
        ({"id": "Bad Id"}, "id must be"),
        ({"auth": "passkey"}, "auth must be"),
        ({"auth": {"header": "Authorization", "template": "Bearer"}}, "template must contain"),
        ({"name": ""}, "name is required"),
        ({"icon": {"path": "M0 0h24v24H0z<script>", "view_box": "0 0 24 24"}}, "icon.path must be"),
        ({"icon": {"path": "M0 0h24v24H0z", "view_box": "0 0 24"}}, "icon.view_box must be"),
        ({"icon": {"path": "M0 " * 2000, "view_box": "0 0 24 24"}}, "icon.path must be"),
        ({"icon": "notion.svg"}, "icon must be"),
    ],
)
def test_a_bad_entry_is_named(over, problem):
    problems = mod.validate(_doc(_entry(**over)))
    assert any(problem in p for p in problems), problems


def test_an_entry_with_an_icon_passes():
    assert mod.validate(_doc(_entry(icon={"path": "M24 0V24l-9.365-8.045V24H0V0Zm1.2e-3 2z", "view_box": "0 0 24 24"}))) == []


def test_most_published_connectors_have_a_logo():
    entries = json.loads(mod.LIST.read_text())["entries"]
    with_icon = {e["id"] for e in entries if "icon" in e}
    assert {"notion", "linear", "github", "stripe"} <= with_icon
    assert len(with_icon) >= 16


def test_ids_are_unique():
    assert any("used twice" in p for p in mod.validate(_doc(_entry(), _entry())))


@pytest.mark.skipif(shutil.which("openssl") is None, reason="needs openssl")
def test_a_signature_verifies_with_the_public_key(tmp_path):
    key = tmp_path / "k.pem"
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(key)], check=True)
    body = b'{"version":1,"entries":[]}'
    sig = base64.b64decode(mod.sign(body, key))
    pub = tmp_path / "pub.pem"
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(pub)], check=True)
    (tmp_path / "body").write_bytes(body)
    (tmp_path / "sig").write_bytes(sig)
    ok = subprocess.run(
        ["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(pub), "-in", str(tmp_path / "body"), "-sigfile", str(tmp_path / "sig")],
        capture_output=True,
    )
    assert ok.returncode == 0, ok.stderr
