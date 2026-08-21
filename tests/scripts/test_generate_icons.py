from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from scripts.generate_icons import (
    BRAND_BG_COLOR,
    MASTER_ICON,
    _composite_rgba_bg,
    _read_png_rgba,
    _resize_rgba_box,
    _write_png_rgba,
    generate_derived_images,
)


def test_pure_python_png_read_write_roundtrip(tmp_path: Path):
    width, height, pixels = _read_png_rgba(MASTER_ICON)
    assert width == 1024
    assert height == 1024
    assert len(pixels) == 1024 * 1024 * 4

    out_path = tmp_path / "test_copy.png"
    _write_png_rgba(str(out_path), width, height, pixels)
    assert out_path.exists()

    r_w, r_h, r_pixels = _read_png_rgba(str(out_path))
    assert (r_w, r_h) == (width, height)
    assert r_pixels == pixels


def test_pure_python_composite_and_resize(tmp_path: Path):
    width, height, pixels = _read_png_rgba(MASTER_ICON)

    # Resize to 64x64
    tray_pixels = _resize_rgba_box(width, height, pixels, 64, 64)
    tray_path = tmp_path / "tray-icon.png"
    _write_png_rgba(str(tray_path), 64, 64, tray_pixels)
    assert tray_path.exists()

    t_w, t_h, _ = _read_png_rgba(str(tray_path))
    assert (t_w, t_h) == (64, 64)

    # Composite with brand background
    app_pixels = _composite_rgba_bg(width, height, pixels, BRAND_BG_COLOR)
    app_path = tmp_path / "app-icon.png"
    _write_png_rgba(str(app_path), width, height, app_pixels)
    assert app_path.exists()

    a_w, a_h, read_app_pixels = _read_png_rgba(str(app_path))
    assert (a_w, a_h) == (1024, 1024)
    # Every alpha byte in the composite should be 255 (opaque)
    for idx in range(3, len(read_app_pixels), 4):
        assert read_app_pixels[idx] == 255


def test_generate_derived_images_fallback(tmp_path: Path):
    tray_target = tmp_path / "desktop" / "tray-icon.png"
    app_target_1 = tmp_path / "desktop" / "icon.png"
    app_target_2 = tmp_path / "mobile" / "icon.png"

    # Force pure Python fallback by mocking PIL import failure
    with patch.dict(sys.modules, {"PIL": None, "PIL.Image": None}):
        generate_derived_images(
            MASTER_ICON,
            str(tray_target),
            [str(app_target_1), str(app_target_2)],
            BRAND_BG_COLOR,
        )

    assert tray_target.exists()
    assert app_target_1.exists()
    assert app_target_2.exists()

    w, h, _ = _read_png_rgba(str(tray_target))
    assert (w, h) == (64, 64)


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
