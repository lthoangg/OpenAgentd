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

import os
import shutil
import subprocess
import sys
import hashlib
import argparse
from PIL import Image

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
    with Image.open(MASTER_ICON) as master_img:
        master_img = master_img.convert("RGBA")
        print(
            f"Generating transparent tray icon: {os.path.relpath(TRAY_ICON, ROOT_DIR)}"
        )
        master_img.resize((64, 64), Image.Resampling.LANCZOS).save(TRAY_ICON, "PNG")
        bg_img = Image.new("RGBA", master_img.size, BRAND_BG_COLOR)
        app_icon_img = Image.alpha_composite(bg_img, master_img)
        for target in APP_COPIES:
            target_dir = os.path.dirname(target)
            os.makedirs(target_dir, exist_ok=True)
            print(
                f"Compositing app icon with brand background for: {os.path.relpath(target, ROOT_DIR)}"
            )
            app_icon_img.save(target, "PNG")

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
