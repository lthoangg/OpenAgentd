from __future__ import annotations

import re
import tomllib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MOBILE = REPO_ROOT / "mobile"
MOBILE_MAKEFILE = MOBILE / "Makefile"
MOBILE_CARGO = MOBILE / "src-tauri" / "Cargo.toml"
PLUGIN = MOBILE / "android-plugin"
PACKAGE_APK = MOBILE / "scripts" / "package-apk.sh"
PUBLISH_APK = MOBILE / "scripts" / "publish-apk.sh"


def _target_recipe(makefile: str, target: str) -> str:
    lines = makefile.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{target}:"))
    recipe = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        recipe.append(line.strip())
    return "\n".join(recipe)


def test_android_apk_builds_release_then_signs():
    recipe = _target_recipe(MOBILE_MAKEFILE.read_text(), "android-apk")

    assert "cargo tauri android build --apk" in recipe
    assert "--debug" not in recipe
    assert recipe.index("cargo tauri android build") < recipe.index("./scripts/package-apk.sh")


def test_android_release_requires_keystore_before_building_then_publishes():
    recipe = _target_recipe(MOBILE_MAKEFILE.read_text(), "android-release")

    assert "ANDROID_KEYSTORE" in recipe
    assert recipe.index("ANDROID_KEYSTORE") < recipe.index("$(MAKE) android-apk")
    assert recipe.index("$(MAKE) android-apk") < recipe.index("./scripts/publish-apk.sh")


def test_ios_clean_keeps_the_android_project():
    recipe = _target_recipe(MOBILE_MAKEFILE.read_text(), "ios-clean")

    assert "src-tauri/gen/apple" in recipe
    assert not re.search(r"src-tauri/gen(\s|$)", recipe)


def test_android_library_is_loadable_and_plugin_is_android_only():
    cargo = tomllib.loads(MOBILE_CARGO.read_text())

    # Android loads the app as a shared library; iOS links the staticlib.
    assert {"staticlib", "cdylib"} <= set(cargo["lib"]["crate-type"])
    android_deps = cargo["target"]['cfg(target_os = "android")']["dependencies"]
    assert android_deps["tauri-plugin-openagentd-android"]["path"] == "../android-plugin"
    assert "tauri-plugin-openagentd-android" not in cargo["dependencies"]


def test_android_plugin_links_matches_name_for_gradle_wiring():
    cargo = tomllib.loads((PLUGIN / "Cargo.toml").read_text())

    # tauri-build reads DEP_<links>_ANDROID_LIBRARY_PATH to add the Kotlin
    # library to the generated Gradle project.
    assert cargo["package"]["links"] == cargo["package"]["name"]


def test_android_plugin_provider_does_not_collide_with_template_fileprovider():
    manifest = (PLUGIN / "android" / "src" / "main" / "AndroidManifest.xml").read_text()

    assert 'android:name="app.openagentd.shell.ShellFileProvider"' in manifest
    assert 'android:name="androidx.core.content.FileProvider"' not in manifest
    assert 'android:exported="false"' in manifest
    assert "android:networkSecurityConfig" in manifest


def test_apk_packaging_signs_without_password_arguments():
    script = PACKAGE_APK.read_text()

    assert "apksigner" in script and "zipalign" in script
    assert "--ks-pass env:" in script
    assert "--key-pass env:" in script
    assert "--ks-pass pass:" not in script


def test_apk_publish_refuses_debug_signature_and_untagged_head():
    script = PUBLISH_APK.read_text()

    assert "CN=Android Debug" in script
    assert "HEAD is not $TAG" in script
    assert "working tree is not clean" in script
    assert "--clobber" in script
    assert 'DRY_RUN="${DRY_RUN:-0}"' in script
