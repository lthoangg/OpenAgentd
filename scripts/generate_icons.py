#!/usr/bin/env python3
"""
Centralized icon generator and synchronizer for OpenAgentd.
Uses documents/assets/brand/openagentd-app-icon.png as the single source of truth
and generates/updates all web, desktop, and mobile icons.

To prevent non-deterministic build outputs (such as icon.icns changes on every run)
from dirtying the git index, this script only regenerates icons if:
1. The master icon has changed (detected via MD5 mismatch with the web copy).
2. Any required platform icon is missing.
3. The script is run with the --force flag.
"""

import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import zlib

# Define paths relative to the repository root
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MASTER_ICON = os.path.join(ROOT_DIR, "documents/assets/brand/openagentd-app-icon.png")

# We use the web copy as a reference to check if the master icon has changed
REF_COPY = os.path.join(ROOT_DIR, "web/public/brand-assets/openagentd-app-icon.png")

TRANSPARENT_COPIES = [
    REF_COPY,
    os.path.join(ROOT_DIR, "web/src/assets/brand/openagentd-app-icon.png"),
]

TRAY_ICON = os.path.join(ROOT_DIR, "desktop/src-tauri/icons/tray-icon.png")

APP_COPIES = [
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/icon.png"),
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/icon.png"),
]

TARGET_COPIES = TRANSPARENT_COPIES + [TRAY_ICON] + APP_COPIES

# Brand background color for desktop/mobile app icons (#FAF6EC matching OpenAgentd warm light theme)
BRAND_BG_COLOR = (250, 246, 236, 255)

REQUIRED_GENERATED_FILES = [
    # Desktop
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/icon.icns"),
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/icon.ico"),
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/32x32.png"),
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/128x128.png"),
    os.path.join(ROOT_DIR, "desktop/src-tauri/icons/128x128@2x.png"),
    # Mobile
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/icon.icns"),
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/icon.ico"),
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/32x32.png"),
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/128x128.png"),
    os.path.join(ROOT_DIR, "mobile/src-tauri/icons/128x128@2x.png"),
]


def get_md5(path):
    if not os.path.exists(path):
        return None
    hasher = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _read_png_rgba(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Not a valid PNG file: {path}")
    idx = 8
    width = height = None
    idat = []
    while idx < len(data):
        length = struct.unpack(">I", data[idx : idx + 4])[0]
        ctype = data[idx + 4 : idx + 8]
        cdata = data[idx + 8 : idx + 8 + length]
        idx += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", cdata[:10])
            if bit_depth != 8 or color_type != 6:
                raise ValueError(
                    f"Unsupported PNG bit depth/color type: {bit_depth}/{color_type}"
                )
        elif ctype == b"IDAT":
            idat.append(cdata)
        elif ctype == b"IEND":
            break
    if width is None or height is None:
        raise ValueError("Missing IHDR chunk in PNG")
    raw = zlib.decompress(b"".join(idat))
    stride = width * 4
    pixels = bytearray(height * stride)
    src_idx = 0
    for y in range(height):
        filter_type = raw[src_idx]
        src_idx += 1
        row = bytearray(raw[src_idx : src_idx + stride])
        src_idx += stride
        prev_row = pixels[(y - 1) * stride : y * stride] if y > 0 else None
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(4, stride):
                row[i] = (row[i] + row[i - 4]) & 0xFF
        elif filter_type == 2:
            if prev_row:
                for i in range(stride):
                    row[i] = (row[i] + prev_row[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0
                b = prev_row[i] if prev_row else 0
                row[i] = (row[i] + ((a + b) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = row[i - 4] if i >= 4 else 0
                b = prev_row[i] if prev_row else 0
                c = prev_row[i - 4] if prev_row and i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 0xFF
        pixels[y * stride : (y + 1) * stride] = row
    return width, height, pixels


def _write_png_rgba(path, width, height, pixels):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        raw.extend(pixels[y * stride : (y + 1) * stride])
    compressed = zlib.compress(raw, level=9)

    def make_chunk(ctype, cdata):
        crc = zlib.crc32(ctype + cdata) & 0xFFFFFFFF
        return struct.pack(">I", len(cdata)) + ctype + cdata + struct.pack(">I", crc)

    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png_data = (
        b"\x89PNG\r\n\x1a\n"
        + make_chunk(b"IHDR", ihdr_data)
        + make_chunk(b"IDAT", compressed)
        + make_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png_data)


def _composite_rgba_bg(width, height, pixels, bg_color):
    bg_r, bg_g, bg_b, bg_a = bg_color
    out = bytearray(len(pixels))
    for i in range(0, len(pixels), 4):
        r, g, b, a = pixels[i : i + 4]
        if a == 255:
            out[i] = r
            out[i + 1] = g
            out[i + 2] = b
            out[i + 3] = 255
        elif a == 0:
            out[i] = bg_r
            out[i + 1] = bg_g
            out[i + 2] = bg_b
            out[i + 3] = bg_a
        else:
            alpha = a / 255.0
            inv = 1.0 - alpha
            out[i] = min(255, max(0, int(r * alpha + bg_r * inv + 0.5)))
            out[i + 1] = min(255, max(0, int(g * alpha + bg_g * inv + 0.5)))
            out[i + 2] = min(255, max(0, int(b * alpha + bg_b * inv + 0.5)))
            out[i + 3] = 255
    return out


def _resize_rgba_box(src_w, src_h, src_pixels, dst_w, dst_h):
    block_x = src_w // dst_w
    block_y = src_h // dst_h
    block_pixels = block_x * block_y
    dst_pixels = bytearray(dst_w * dst_h * 4)
    src_stride = src_w * 4
    dst_stride = dst_w * 4

    for dy in range(dst_h):
        sy_start = dy * block_y
        for dx in range(dst_w):
            sx_start = dx * block_x
            r_sum = g_sum = b_sum = a_sum = 0
            for sy in range(sy_start, sy_start + block_y):
                row_offset = sy * src_stride
                for sx in range(sx_start, sx_start + block_x):
                    p_offset = row_offset + sx * 4
                    r_sum += src_pixels[p_offset]
                    g_sum += src_pixels[p_offset + 1]
                    b_sum += src_pixels[p_offset + 2]
                    a_sum += src_pixels[p_offset + 3]
            dst_offset = dy * dst_stride + dx * 4
            dst_pixels[dst_offset] = r_sum // block_pixels
            dst_pixels[dst_offset + 1] = g_sum // block_pixels
            dst_pixels[dst_offset + 2] = b_sum // block_pixels
            dst_pixels[dst_offset + 3] = a_sum // block_pixels
    return dst_pixels


def generate_derived_images(master_path, tray_path, app_paths, bg_color):
    try:
        from PIL import Image

        with Image.open(master_path) as master_img:
            master_img = master_img.convert("RGBA")
            print(
                f"Generating transparent tray icon: {os.path.relpath(tray_path, ROOT_DIR)}"
            )
            os.makedirs(os.path.dirname(tray_path), exist_ok=True)
            master_img.resize((64, 64), Image.Resampling.LANCZOS).save(tray_path, "PNG")
            bg_img = Image.new("RGBA", master_img.size, bg_color)
            app_icon_img = Image.alpha_composite(bg_img, master_img)
            for target in app_paths:
                target_dir = os.path.dirname(target)
                os.makedirs(target_dir, exist_ok=True)
                print(
                    f"Compositing app icon with brand background for: {os.path.relpath(target, ROOT_DIR)}"
                )
                app_icon_img.save(target, "PNG")
    except ImportError:
        w, h, pixels = _read_png_rgba(master_path)
        os.makedirs(os.path.dirname(tray_path), exist_ok=True)
        print(
            f"Generating transparent tray icon (pure Python): {os.path.relpath(tray_path, ROOT_DIR)}"
        )
        tray_pixels = _resize_rgba_box(w, h, pixels, 64, 64)
        _write_png_rgba(tray_path, 64, 64, tray_pixels)

        app_pixels = _composite_rgba_bg(w, h, pixels, bg_color)
        for target in app_paths:
            target_dir = os.path.dirname(target)
            os.makedirs(target_dir, exist_ok=True)
            print(
                f"Compositing app icon with brand background for (pure Python): {os.path.relpath(target, ROOT_DIR)}"
            )
            _write_png_rgba(target, w, h, app_pixels)


def main():
    parser = argparse.ArgumentParser(
        description="Centralized icon generator and synchronizer."
    )
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force regeneration of all icons even if unchanged.",
    )
    args = parser.parse_args()

    if not os.path.exists(MASTER_ICON):
        print(f"Error: Master icon not found at {MASTER_ICON}")
        sys.exit(1)

    # Check if regeneration is needed
    master_hash = get_md5(MASTER_ICON)
    ref_hash = get_md5(REF_COPY)

    # Check if any required file is missing
    missing_files = [f for f in REQUIRED_GENERATED_FILES if not os.path.exists(f)]

    # We need to run if:
    # 1. Force flag is set
    # 2. Master icon hash doesn't match the reference copy (meaning master was updated)
    # 3. Any target copies are missing
    # 4. Any required generated files are missing
    needs_run = False
    reasons = []

    if args.force:
        needs_run = True
        reasons.append("force flag was specified")

    if master_hash != ref_hash:
        needs_run = True
        reasons.append("master brand icon has changed or reference copy is missing")

    for copy_path in TARGET_COPIES:
        if not os.path.exists(copy_path):
            needs_run = True
            reasons.append(
                f"target copy is missing: {os.path.relpath(copy_path, ROOT_DIR)}"
            )
            break

    if missing_files:
        needs_run = True
        reasons.append(
            f"required generated files are missing: {', '.join(os.path.relpath(f, ROOT_DIR) for f in missing_files[:3])}..."
        )

    if not needs_run:
        print(
            "Icons are already centralized, up-to-date, and fully synchronized. Skipping regeneration."
        )
        print("Use --force or -f to force regeneration.")
        sys.exit(0)

    print(f"Regenerating icons because: {', '.join(reasons)}")
    print(f"Found master icon: {MASTER_ICON}")

    # Copy master transparent icon to web targets
    for target in TRANSPARENT_COPIES:
        target_dir = os.path.dirname(target)
        os.makedirs(target_dir, exist_ok=True)
        print(
            f"Copying master transparent icon to web: {os.path.relpath(target, ROOT_DIR)}"
        )
        shutil.copy2(MASTER_ICON, target)

    # Keep the macOS template icon transparent, while platform app icons use
    # a solid canvas so the Dock does not draw a fallback gray tile.
    generate_derived_images(MASTER_ICON, TRAY_ICON, APP_COPIES, BRAND_BG_COLOR)

    # Check for tauri cli
    tauri_cmd = None
    if shutil.which("cargo"):
        try:
            res = subprocess.run(
                ["cargo", "tauri", "--version"], capture_output=True, text=True
            )
            if res.returncode == 0:
                tauri_cmd = ["cargo", "tauri"]
        except Exception:
            pass

    if not tauri_cmd and shutil.which("bun"):
        tauri_cmd = ["bunx", "tauri"]
    elif not tauri_cmd and shutil.which("npx"):
        tauri_cmd = ["npx", "tauri"]

    if not tauri_cmd:
        print("Warning: Neither 'cargo tauri' nor 'bunx/npx tauri' was found in PATH.")
        print("Tauri platform-specific icons could not be generated.")
        print("Please install tauri-cli to generate platform icons:")
        print("  cargo install tauri-cli --version '^2'")
        print("  or use bun/npm in the web directory.")
        sys.exit(0)

    print(f"Using Tauri CLI command: {' '.join(tauri_cmd)}")

    # Generate desktop icons
    desktop_tauri_dir = os.path.join(ROOT_DIR, "desktop/src-tauri")
    if os.path.exists(desktop_tauri_dir):
        print("Generating desktop platform icons...")
        for f in [
            "32x32.png",
            "64x64.png",
            "128x128.png",
            "128x128@2x.png",
            "icon.icns",
            "icon.ico",
        ]:
            path = os.path.join(desktop_tauri_dir, "icons", f)
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception as e:
                    print(f"Warning: could not remove {path}: {e}")

        try:
            subprocess.run(
                [*tauri_cmd, "icon", "icons/icon.png"],
                cwd=desktop_tauri_dir,
                check=True,
            )
            print("Desktop platform icons generated successfully.")
        except subprocess.CalledProcessError as e:
            print(f"Error generating desktop icons: {e}")
            sys.exit(1)

    # Generate mobile icons
    mobile_tauri_dir = os.path.join(ROOT_DIR, "mobile/src-tauri")
    if os.path.exists(mobile_tauri_dir):
        print("Generating mobile platform icons...")
        for f in [
            "32x32.png",
            "64x64.png",
            "128x128.png",
            "128x128@2x.png",
            "icon.icns",
            "icon.ico",
        ]:
            path = os.path.join(mobile_tauri_dir, "icons", f)
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception as e:
                    print(f"Warning: could not remove {path}: {e}")

        try:
            subprocess.run(
                [*tauri_cmd, "icon", "icons/icon.png", "--ios-color", "transparent"],
                cwd=mobile_tauri_dir,
                check=True,
            )
            print("Mobile platform icons generated successfully.")
        except subprocess.CalledProcessError as e:
            print(f"Error generating mobile icons: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
