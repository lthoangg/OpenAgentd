"""mobile/scripts/patch-ios-widget.sh adds the home-screen widget extension to
the generated Xcode project, and the IPA packaging keeps its App Group."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MOBILE = REPO_ROOT / "mobile"
SCRIPT = MOBILE / "scripts" / "patch-ios-widget.sh"
MAKEFILE = MOBILE / "Makefile"
PACKAGE_IPA = MOBILE / "scripts" / "package-ipa.sh"
PUBLISH_IPA = MOBILE / "scripts" / "publish-ipa.sh"
INFO_IOS_PLIST = MOBILE / "src-tauri" / "Info.ios.plist"

# The shape `cargo tauri ios init` writes (trimmed), ending without a newline.
TEMPLATE = """name: openagentd-mobile
options:
  bundleIdPrefix: com.openagentd.mobile
targets:
  openagentd-mobile_iOS:
    type: application
    platform: iOS
    sources:
      - path: Sources
      - path: Assets.xcassets
    info:
      path: openagentd-mobile_iOS/Info.plist
    entitlements:
      path: openagentd-mobile_iOS/openagentd-mobile_iOS.entitlements
    settings:
      groups: [app]
    dependencies:
      - framework: libapp.a
        embed: false
      - sdk: UIKit.framework
    preBuildScripts:
      - script: cargo tauri ios xcode-script -v
        name: Build Rust Code
        outputFiles:
          - $(SRCROOT)/Externals/arm64/${CONFIGURATION}/libapp.a"""


def _project(tmp_path: Path) -> Path:
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)
    apple = mobile / "src-tauri" / "gen" / "apple"
    (apple / "openagentd-mobile.xcodeproj").mkdir(parents=True)
    (apple / "openagentd-mobile.xcodeproj" / "project.pbxproj").write_text("// generated\n")
    (apple / "project.yml").write_text(TEMPLATE)
    (mobile / "src-tauri" / "tauri.conf.json").write_text(json.dumps({
        "identifier": "com.openagentd.mobile",
        "version": "9.8.7",
        "bundle": {"iOS": {"developmentTeam": "TEAM123"}},
    }))
    # A stand-in xcodegen that records each regeneration.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    xcodegen = bin_dir / "xcodegen"
    xcodegen.write_text('#!/usr/bin/env bash\necho "$PWD $*" >> "$XCODEGEN_LOG"\n')
    xcodegen.chmod(0o755)
    return mobile


def _run(mobile: Path, **env: str) -> subprocess.CompletedProcess[str]:
    log = mobile.parent / "xcodegen.log"
    return subprocess.run(
        ["bash", str(mobile / "scripts" / SCRIPT.name)],
        capture_output=True,
        text=True,
        check=True,
        env={
            **os.environ,
            "PATH": f"{mobile.parent / 'bin'}:{os.environ['PATH']}",
            "XCODEGEN_LOG": str(log),
            **env,
        },
    )


def _yml(mobile: Path) -> str:
    return (mobile / "src-tauri" / "gen" / "apple" / "project.yml").read_text()


def _regenerations(mobile: Path) -> int:
    log = mobile.parent / "xcodegen.log"
    return len(log.read_text().splitlines()) if log.exists() else 0


def test_adds_the_widget_extension_embedded_in_the_app(tmp_path: Path):
    mobile = _project(tmp_path)

    _run(mobile)
    yml = _yml(mobile)

    assert "  OpenAgentdWidgets:\n    type: app-extension\n" in yml
    assert "      - target: OpenAgentdWidgets # openagentd-widgets\n" in yml
    assert "      - path: ../../../ios-widget/App # openagentd-widgets\n" in yml
    assert "      - path: ../../../ios-widget/Extension\n" in yml
    assert yml.count("      - path: ../../../ios-widget/Shared") == 2
    assert "        NSExtensionPointIdentifier: com.apple.widgetkit-extension\n" in yml
    # The template's last line is not glued to the appended block.
    assert "libapp.a\n  # >>> OpenAgentdWidgets" in yml
    assert _regenerations(mobile) == 1


def test_app_and_extension_share_an_app_group_named_after_the_app(tmp_path: Path):
    mobile = _project(tmp_path)

    _run(mobile)
    yml = _yml(mobile)

    assert "          - group.$(PRODUCT_BUNDLE_IDENTIFIER) # openagentd-widgets\n" in yml
    assert "          - group.$(OA_APP_BUNDLE_ID)\n" in yml
    assert "        OA_APP_BUNDLE_ID: com.openagentd.mobile\n" in yml
    assert "        PRODUCT_BUNDLE_IDENTIFIER: com.openagentd.mobile.widgets\n" in yml
    assert '        CFBundleShortVersionString: "9.8.7"\n' in yml
    assert "        DEVELOPMENT_TEAM: TEAM123\n" in yml


def test_running_again_changes_nothing_and_skips_xcodegen(tmp_path: Path):
    mobile = _project(tmp_path)
    _run(mobile)
    # A real xcodegen run leaves the target in the project.
    pbxproj = mobile / "src-tauri" / "gen" / "apple" / "openagentd-mobile.xcodeproj" / "project.pbxproj"
    pbxproj.write_text("// OpenAgentdWidgets\n")
    first = _yml(mobile)

    _run(mobile)

    assert _yml(mobile) == first
    assert first.count("OpenAgentdWidgets:") == 1
    assert _regenerations(mobile) == 1


def test_follows_the_dev_bundle_id_and_back(tmp_path: Path):
    mobile = _project(tmp_path)

    _run(mobile, IOS_APP_ID="com.dev.openagentd.mobile")
    assert "        PRODUCT_BUNDLE_IDENTIFIER: com.dev.openagentd.mobile.widgets\n" in _yml(mobile)

    _run(mobile)
    yml = _yml(mobile)
    assert "        PRODUCT_BUNDLE_IDENTIFIER: com.openagentd.mobile.widgets\n" in yml
    assert "com.dev.openagentd.mobile" not in yml
    assert yml.count("OpenAgentdWidgets:") == 1


def test_skips_without_a_generated_project(tmp_path: Path):
    mobile = tmp_path / "mobile"
    (mobile / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, mobile / "scripts" / SCRIPT.name)

    result = subprocess.run(["bash", str(mobile / "scripts" / SCRIPT.name)], capture_output=True, text=True, check=True)

    assert "skipping" in result.stderr


def test_patch_is_executable():
    assert os.access(SCRIPT, os.X_OK)


def _recipe(target: str) -> list[str]:
    lines = MAKEFILE.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{target}:"))
    recipe = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        recipe.append(line.strip())
    return recipe


def test_every_ios_build_adds_the_widget_before_the_xcode_patch():
    for target in ("ios-init", "ios-dev", "ios-dev-device", "ios-install-device", "ios-install-device-fast", "ios-ipa", "ios-build"):
        recipe = _recipe(target)
        widget = next(i for i, line in enumerate(recipe) if "patch-ios-widget.sh" in line)
        xcode = next(i for i, line in enumerate(recipe) if "patch-xcode-project.sh" in line)
        assert widget < xcode, target


def test_dev_device_builds_use_the_dev_bundle_id():
    assert "IOS_APP_ID=$(IOS_DEV_IDENTIFIER) ./scripts/patch-ios-widget.sh" in _recipe("ios-dev-device")


def test_app_names_its_app_group_for_the_widget_storage():
    plist = INFO_IOS_PLIST.read_text()
    assert "<key>OAWidgetAppGroup</key>\n  <string>group.$(PRODUCT_BUNDLE_IDENTIFIER)</string>" in plist


def test_ipa_keeps_only_the_app_group_entitlement():
    script = PACKAGE_IPA.read_text()
    assert "com.apple.security.application-groups" in script
    assert '--entitlements "$group_entitlements" "$appex"' in script
    assert '--entitlements "$group_entitlements" "$app"' in script
    assert 'app_group="group.$bundle_id"' in script


def test_sidestore_source_lists_the_app_group_entitlement():
    assert "--entitlement com.apple.security.application-groups" in PUBLISH_IPA.read_text()
