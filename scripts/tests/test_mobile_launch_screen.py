from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "mobile" / "scripts" / "patch-launch-screen.sh"

# What `cargo tauri ios init` generates: the system background, white in light
# mode and black in dark mode.
TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="17150" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="Y6W-OH-hqX">
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="17122"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="System colors in document resources" minToolsVersion="11.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <scene sceneID="s0d-6b-0kx">
            <objects>
                <viewController id="Y6W-OH-hqX" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="5EZ-qb-Rvc">
                        <rect key="frame" x="0.0" y="0.0" width="414" height="896"/>
                        <color key="backgroundColor" systemColor="systemBackgroundColor"/>
                    </view>
                </viewController>
            </objects>
        </scene>
    </scenes>
    <resources>
        <systemColor name="systemBackgroundColor">
            <color white="1" alpha="1" colorSpace="custom" customColorSpace="genericGamma22GrayColorSpace"/>
        </systemColor>
    </resources>
</document>
"""

# What the light-only version of the script left behind.
LIGHT_ONLY = TEMPLATE.replace(
    '<color key="backgroundColor" systemColor="systemBackgroundColor"/>',
    '<color key="backgroundColor" red="0.980392157" green="0.964705882" blue="0.925490196" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>',
)


def _project(tmp_path: Path, storyboard: str) -> Path:
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)
    apple = mobile / "src-tauri" / "gen" / "apple"
    (apple / "Assets.xcassets").mkdir(parents=True)
    (apple / "Assets.xcassets" / "Contents.json").write_text('{"info": {"version": 1, "author": "xcode"}}')
    (apple / "LaunchScreen.storyboard").write_text(storyboard)
    return mobile


def _run(mobile: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(mobile / "scripts" / SCRIPT.name)],
        capture_output=True,
        text=True,
        check=True,
    )


def _colorset(mobile: Path) -> dict[str, str]:
    path = mobile / "src-tauri" / "gen" / "apple" / "Assets.xcassets" / "LaunchBackground.colorset" / "Contents.json"
    entries = json.loads(path.read_text())["colors"]
    by_appearance = {}
    for entry in entries:
        appearance = next((a["value"] for a in entry.get("appearances", [])), "any")
        c = entry["color"]["components"]
        by_appearance[appearance] = "#" + "".join(f"{round(float(c[k]) * 255):02X}" for k in ("red", "green", "blue"))
    return by_appearance


def test_launch_screen_is_paper_in_light_mode_and_ink_in_dark_mode(tmp_path: Path):
    mobile = _project(tmp_path, TEMPLATE)

    _run(mobile)

    storyboard = (mobile / "src-tauri" / "gen" / "apple" / "LaunchScreen.storyboard").read_text()
    assert '<color key="backgroundColor" name="LaunchBackground"/>' in storyboard
    assert 'systemColor="systemBackgroundColor"/>' not in storyboard
    assert '<namedColor name="LaunchBackground">' in storyboard
    assert '<capability name="Named colors" minToolsVersion="9.0"/>' in storyboard
    # The same tones as index.html's pre-paint CSS, so launch hands off to the
    # app with no flash in either appearance.
    assert _colorset(mobile) == {"any": "#FAF6EC", "dark": "#15110D"}


def test_launch_screen_patch_upgrades_the_light_only_patch(tmp_path: Path):
    mobile = _project(tmp_path, LIGHT_ONLY)

    _run(mobile)

    storyboard = (mobile / "src-tauri" / "gen" / "apple" / "LaunchScreen.storyboard").read_text()
    assert '<color key="backgroundColor" name="LaunchBackground"/>' in storyboard
    assert _colorset(mobile)["dark"] == "#15110D"


def test_launch_screen_patch_can_run_twice(tmp_path: Path):
    mobile = _project(tmp_path, TEMPLATE)

    _run(mobile)
    first = (mobile / "src-tauri" / "gen" / "apple" / "LaunchScreen.storyboard").read_text()
    _run(mobile)
    second = (mobile / "src-tauri" / "gen" / "apple" / "LaunchScreen.storyboard").read_text()

    assert second == first
    assert second.count('<namedColor name="LaunchBackground">') == 1
    assert second.count('name="Named colors"') == 1


def test_launch_screen_patch_skips_without_a_generated_project(tmp_path: Path):
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)

    result = _run(mobile)

    assert "skipping" in result.stderr


def test_launch_screen_patch_is_executable():
    # mobile/Makefile runs it as ./scripts/patch-launch-screen.sh.
    assert os.access(SCRIPT, os.X_OK)
