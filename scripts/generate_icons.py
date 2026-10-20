#!/usr/bin/env python3
"""
Centralized icon generator and synchronizer for OpenAgentd.

Turns the logo's platform masters into every native icon. The masters are
1024 px PNGs rendered from the Seal by scripts/brand/brand.ts:

- documents/assets/brand/icons/openagentd-icon-macos.png    (macOS, Linux)
- documents/assets/brand/icons/openagentd-icon-windows.png  (.ico, Store logos)
- documents/assets/brand/openagentd-app-icon.png            (iOS, Android legacy)
- documents/assets/brand/icons/openagentd-icon-android-foreground.png
- documents/assets/brand/icons/openagentd-tray-template.png (macOS menu bar)
- documents/assets/brand/icons/mobile-icons.json            (Tauri icon manifest)

Each `cargo tauri icon` run writes to a scratch folder under the shell's
target/ (never into gen/, never over a master) and only the files each
bundle needs are copied out. iOS icons are saved without an alpha channel.

Icons are regenerated only when a master changed since the last run (the
md5s in desktop/src-tauri/icons/.brand-masters.json), a required output is
missing, or --force is given.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BRAND_DIR = os.path.join(ROOT_DIR, "documents/assets/brand")
ICONS_DIR = os.path.join(BRAND_DIR, "icons")

MACOS_MASTER = os.path.join(ICONS_DIR, "openagentd-icon-macos.png")
WINDOWS_MASTER = os.path.join(ICONS_DIR, "openagentd-icon-windows.png")
IOS_MASTER = os.path.join(BRAND_DIR, "openagentd-app-icon.png")
ANDROID_FG_MASTER = os.path.join(ICONS_DIR, "openagentd-icon-android-foreground.png")
TRAY_MASTER = os.path.join(ICONS_DIR, "openagentd-tray-template.png")
MOBILE_MANIFEST = os.path.join(ICONS_DIR, "mobile-icons.json")
MASTERS = [MACOS_MASTER, WINDOWS_MASTER, IOS_MASTER, ANDROID_FG_MASTER, TRAY_MASTER, MOBILE_MANIFEST]

DESKTOP_TAURI = os.path.join(ROOT_DIR, "desktop/src-tauri")
MOBILE_TAURI = os.path.join(ROOT_DIR, "mobile/src-tauri")
DESKTOP_ICONS = os.path.join(DESKTOP_TAURI, "icons")
MOBILE_ICONS = os.path.join(MOBILE_TAURI, "icons")
STAMP = os.path.join(DESKTOP_ICONS, ".brand-masters.json")
TRAY_ICON = os.path.join(DESKTOP_ICONS, "tray-icon.png")
MOBILE_ICON = os.path.join(MOBILE_ICONS, "icon.png")

# What each `tauri icon` run contributes to the desktop bundle.
DESKTOP_FROM_MACOS = ["icon.icns", "icon.png", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"]
DESKTOP_FROM_WINDOWS = ["icon.ico", "StoreLogo.png"] + [
    f"Square{size}x{size}Logo.png" for size in (30, 44, 71, 89, 107, 142, 150, 284, 310)
]
# The mobile bundle config lists these (gitignored, generated locally).
MOBILE_BUNDLE = ["icon.icns", "icon.ico", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png"]

REQUIRED_OUTPUTS = (
    [os.path.join(DESKTOP_ICONS, f) for f in DESKTOP_FROM_MACOS + DESKTOP_FROM_WINDOWS]
    + [TRAY_ICON, MOBILE_ICON]
    + [os.path.join(MOBILE_ICONS, f) for f in MOBILE_BUNDLE]
    + [
        os.path.join(MOBILE_ICONS, "ios/AppIcon-512@2x.png"),
        os.path.join(MOBILE_ICONS, "android/values/ic_launcher_background.xml"),
    ]
)


def rel(path):
    return os.path.relpath(path, ROOT_DIR)


def get_md5(path):
    if not os.path.exists(path):
        return None
    hasher = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def master_hashes(masters):
    """The md5 of each master, keyed by its repository-relative path."""
    return {rel(path): get_md5(path) for path in masters}


def needs_regeneration(masters, stamp_path, required):
    """Reasons to regenerate; empty when every output is current."""
    reasons = []
    try:
        with open(stamp_path, encoding="utf-8") as f:
            stamp = json.load(f)
    except (OSError, ValueError):
        stamp = None
    if stamp is None:
        reasons.append(f"no master stamp at {rel(stamp_path)}")
    elif stamp != master_hashes(masters):
        reasons.append("a brand master changed since the last run")
    missing = [path for path in required if not os.path.exists(path)]
    if missing:
        shown = ", ".join(rel(path) for path in missing[:3])
        reasons.append(f"outputs are missing: {shown}{'…' if len(missing) > 3 else ''}")
    return reasons


def write_stamp(masters, stamp_path):
    with open(stamp_path, "w", encoding="utf-8") as f:
        json.dump(master_hashes(masters), f, indent=2, sort_keys=True)
        f.write("\n")


def drop_alpha(paths):
    """Re-save PNGs as RGB: the App Store rejects icons with an alpha channel."""
    from PIL import Image

    for path in paths:
        with Image.open(path) as img:
            rgb = img.convert("RGB")
        rgb.save(path, "PNG", optimize=True)


def save_rgba(src, dst):
    """Copy a PNG as RGBA: tauri's generate_context! rejects any other icon mode."""
    from PIL import Image

    with Image.open(src) as img:
        rgba = img.convert("RGBA")
    rgba.save(dst, "PNG", optimize=True)


def copy_files(src_dir, names, dst_dir):
    os.makedirs(dst_dir, exist_ok=True)
    for name in names:
        shutil.copyfile(os.path.join(src_dir, name), os.path.join(dst_dir, name))


def replace_tree(src_dir, dst_dir):
    shutil.rmtree(dst_dir, ignore_errors=True)
    shutil.copytree(src_dir, dst_dir)


def find_tauri_cmd():
    if shutil.which("cargo"):
        try:
            res = subprocess.run(["cargo", "tauri", "--version"], capture_output=True, text=True)
            if res.returncode == 0:
                return ["cargo", "tauri"]
        except OSError:
            pass
    if shutil.which("bun"):
        return ["bunx", "tauri"]
    if shutil.which("npx"):
        return ["npx", "tauri"]
    return None


def tauri_icon(tauri_cmd, source, out_dir, cwd):
    """Run `tauri icon` into a fresh scratch folder and return it."""
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    print(f"tauri icon {rel(source)} -> {rel(out_dir)}")
    subprocess.run([*tauri_cmd, "icon", source, "-o", out_dir], cwd=cwd, check=True)
    return out_dir


def main():
    parser = argparse.ArgumentParser(description="Centralized icon generator and synchronizer.")
    parser.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force regeneration of all icons even if unchanged.",
    )
    args = parser.parse_args()

    missing_masters = [path for path in MASTERS if not os.path.exists(path)]
    if missing_masters:
        print(f"Error: brand masters not found: {', '.join(rel(p) for p in missing_masters)}")
        print("Render them with: bun install --cwd scripts/brand && bun scripts/brand/brand.ts")
        sys.exit(1)

    reasons = ["force flag was specified"] if args.force else []
    reasons += needs_regeneration(MASTERS, STAMP, REQUIRED_OUTPUTS)
    if not reasons:
        print("Icons are already centralized, up-to-date, and fully synchronized. Skipping regeneration.")
        print("Use --force or -f to force regeneration.")
        sys.exit(0)
    print(f"Regenerating icons because: {'; '.join(reasons)}")

    # The menu bar template as is; the mobile bundle icon is the opaque iOS
    # master stored as RGBA, which `tauri::generate_context!` requires.
    shutil.copyfile(TRAY_MASTER, TRAY_ICON)
    os.makedirs(MOBILE_ICONS, exist_ok=True)
    save_rgba(IOS_MASTER, MOBILE_ICON)

    tauri_cmd = find_tauri_cmd()
    if not tauri_cmd:
        print("Warning: Neither 'cargo tauri' nor 'bunx/npx tauri' was found in PATH.")
        print("Tauri platform-specific icons could not be generated.")
        print("Please install tauri-cli to generate platform icons:")
        print("  cargo install tauri-cli --version '^2'")
        sys.exit(0)
    print(f"Using Tauri CLI command: {' '.join(tauri_cmd)}")

    scratch = os.path.join(DESKTOP_TAURI, "target/brand-icons")
    try:
        # Desktop: macOS and Linux from the inset tile, Windows from the
        # full-bleed tile.
        macos = tauri_icon(tauri_cmd, MACOS_MASTER, os.path.join(scratch, "macos"), DESKTOP_TAURI)
        copy_files(macos, DESKTOP_FROM_MACOS, DESKTOP_ICONS)
        windows = tauri_icon(tauri_cmd, WINDOWS_MASTER, os.path.join(scratch, "windows"), DESKTOP_TAURI)
        copy_files(windows, DESKTOP_FROM_WINDOWS, DESKTOP_ICONS)

        # Mobile: the manifest sets the opaque iOS source, the Android
        # adaptive foreground, and the Paper background color.
        mobile = tauri_icon(tauri_cmd, MOBILE_MANIFEST, os.path.join(scratch, "mobile"), MOBILE_TAURI)
        copy_files(mobile, MOBILE_BUNDLE, MOBILE_ICONS)
        ios_dir = os.path.join(MOBILE_ICONS, "ios")
        replace_tree(os.path.join(mobile, "ios"), ios_dir)
        drop_alpha(os.path.join(ios_dir, name) for name in sorted(os.listdir(ios_dir)) if name.endswith(".png"))
        replace_tree(os.path.join(mobile, "android"), os.path.join(MOBILE_ICONS, "android"))
    except subprocess.CalledProcessError as e:
        print(f"Error generating platform icons: {e}")
        sys.exit(1)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    write_stamp(MASTERS, STAMP)
    print("Platform icons generated successfully.")


if __name__ == "__main__":
    main()
