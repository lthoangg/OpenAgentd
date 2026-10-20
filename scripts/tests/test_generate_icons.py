from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

from scripts.generate_icons import (
    ANDROID_FG_MASTER,
    DESKTOP_ICONS,
    IOS_MASTER,
    MACOS_MASTER,
    MASTERS,
    MOBILE_ICON,
    MOBILE_MANIFEST,
    STAMP,
    TRAY_ICON,
    TRAY_MASTER,
    WINDOWS_MASTER,
    drop_alpha,
    get_md5,
    master_hashes,
    needs_regeneration,
    save_rgba,
    write_stamp,
)


def _rgba(path: str) -> Image.Image:
    img = Image.open(path)
    assert img.mode == "RGBA", path
    return img


def test_tile_masters_are_1024_rgba_with_transparent_corners():
    for path in (MACOS_MASTER, WINDOWS_MASTER, ANDROID_FG_MASTER):
        img = _rgba(path)
        assert img.size == (1024, 1024)
        assert img.getchannel("A").getpixel((0, 0)) == 0


def test_ios_master_is_opaque_rgb():
    img = Image.open(IOS_MASTER)
    assert img.size == (1024, 1024)
    assert img.mode == "RGB"


def test_tray_master_is_a_64px_template():
    img = _rgba(TRAY_MASTER)
    assert img.size == (64, 64)
    hist = img.getchannel("A").histogram()
    assert hist[0] > 0 and sum(hist[1:]) > 0


def test_committed_copies_match_their_masters():
    assert get_md5(TRAY_ICON) == get_md5(TRAY_MASTER)
    # tauri::generate_context! needs an RGBA bundle icon; same pixels as the
    # opaque master.
    mobile = Image.open(MOBILE_ICON)
    assert mobile.mode == "RGBA"
    assert mobile.tobytes() == Image.open(IOS_MASTER).convert("RGBA").tobytes()


def test_stamp_matches_current_masters():
    # Fails when a master is committed without running generate_icons.py.
    with open(STAMP, encoding="utf-8") as f:
        assert json.load(f) == master_hashes(MASTERS)


def test_committed_bundle_icons_have_platform_sizes():
    ico_sizes = set(Image.open(os.path.join(DESKTOP_ICONS, "icon.ico")).info["sizes"])
    assert {(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)} <= ico_sizes
    icns_sizes = set(Image.open(os.path.join(DESKTOP_ICONS, "icon.icns")).info["sizes"])
    assert (512, 512, 2) in icns_sizes


def test_mobile_manifest_points_at_existing_masters():
    with open(MOBILE_MANIFEST, encoding="utf-8") as f:
        manifest = json.load(f)
    base = Path(MOBILE_MANIFEST).parent
    assert manifest["bg_color"].upper() == "#FAF6EC"
    for key in ("default", "android_fg"):
        assert (base / manifest[key]).resolve().exists(), key


def test_needs_regeneration(tmp_path: Path):
    master = tmp_path / "master.png"
    master.write_bytes(b"one")
    output = tmp_path / "out.png"
    output.write_bytes(b"x")
    stamp = tmp_path / "stamp.json"

    assert any("stamp" in r for r in needs_regeneration([str(master)], str(stamp), [str(output)]))

    write_stamp([str(master)], str(stamp))
    assert needs_regeneration([str(master)], str(stamp), [str(output)]) == []

    master.write_bytes(b"two")
    assert any("changed" in r for r in needs_regeneration([str(master)], str(stamp), [str(output)]))

    write_stamp([str(master)], str(stamp))
    output.unlink()
    assert any("missing" in r for r in needs_regeneration([str(master)], str(stamp), [str(output)]))


def test_drop_alpha_writes_rgb(tmp_path: Path):
    path = tmp_path / "icon.png"
    Image.new("RGBA", (8, 8), (250, 246, 236, 255)).save(path)
    drop_alpha([str(path)])
    assert Image.open(path).mode == "RGB"


def test_save_rgba_writes_rgba(tmp_path: Path):
    src = tmp_path / "rgb.png"
    dst = tmp_path / "rgba.png"
    Image.new("RGB", (8, 8), (250, 246, 236)).save(src)
    save_rgba(str(src), str(dst))
    assert Image.open(dst).mode == "RGBA"


def test_generate_icons_script_cli():
    repo_root = Path(__file__).resolve().parents[2]
    script_path = repo_root / "scripts" / "generate_icons.py"

    res = subprocess.run(
        [sys.executable, str(script_path), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert res.returncode == 0
    assert "Centralized icon generator and synchronizer" in res.stdout
