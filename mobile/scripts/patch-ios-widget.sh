#!/usr/bin/env bash
#
# Add the home-screen widget extension (mobile/ios-widget/) to the generated
# Xcode project:
#
# * an `OpenAgentdWidgets` app-extension target built from
#   ios-widget/Extension + ios-widget/Shared, embedded in the app;
# * ios-widget/App + ios-widget/Shared compiled into the app target (the
#   Swift bridge the Rust shell calls to store the widget snapshot);
# * an App Group, `group.<app bundle id>`, on both, so they share storage.
#
# `cargo tauri ios init` regenerates `src-tauri/gen/apple/` from a template,
# so this runs after every init and before every build (see mobile/Makefile).
# It rewrites its own block each run, so the extension follows the app's
# bundle id (IOS_APP_ID, default: tauri.conf.json's identifier) and version.
# It regenerates the .xcodeproj with xcodegen only when project.yml changed.

set -euo pipefail

cd "$(dirname "$0")/.."

project_yml="src-tauri/gen/apple/project.yml"
if [ ! -f "$project_yml" ]; then
  echo "patch-ios-widget: no $project_yml — skipping (run after 'cargo tauri ios init')" >&2
  exit 0
fi

status=0
PROJECT_YML="$project_yml" IOS_APP_ID="${IOS_APP_ID:-}" python3 - <<'PY' || status=$?
import json
import os
import re
import sys

path = os.environ["PROJECT_YML"]
config = json.load(open("src-tauri/tauri.conf.json"))
app_id = os.environ.get("IOS_APP_ID") or config["identifier"]
version = config["version"]
team = config.get("bundle", {}).get("iOS", {}).get("developmentTeam", "")
if not re.fullmatch(r"[A-Za-z0-9.-]+", app_id):
    sys.exit(f"patch-ios-widget: bad bundle id {app_id!r}")

APP_TARGET = "openagentd-mobile_iOS"
EXT_TARGET = "OpenAgentdWidgets"
MARK = "# openagentd-widgets"
BEGIN = f"  # >>> {EXT_TARGET} (scripts/patch-ios-widget.sh)\n"
END = f"  # <<< {EXT_TARGET}\n"

original = open(path).read()
# The template ends without a newline; the block appended below needs one.
lines = (original if original.endswith("\n") else original + "\n").splitlines(keepends=True)

# Drop everything an earlier run added, so the rewrite below is the only copy.
cleaned, skipping = [], False
for line in lines:
    if line == BEGIN:
        skipping = True
        continue
    if skipping:
        if line == END:
            skipping = False
        continue
    if line.rstrip("\n").endswith(MARK):
        continue
    cleaned.append(line)
lines = cleaned

start = next((i for i, line in enumerate(lines) if line == f"  {APP_TARGET}:\n"), None)
if start is None:
    sys.exit(f"patch-ios-widget: target {APP_TARGET} not found in {path}")
end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  \S", lines[i]) or re.match(r"^\S", lines[i])), len(lines))


def find(key):
    for i in range(start + 1, end):
        if lines[i] == f"    {key}:\n":
            return i
    sys.exit(f"patch-ios-widget: {APP_TARGET}.{key} not found in {path}")


# Insert bottom-up so earlier indexes stay valid.
inserts = [
    (find("sources") + 1, [
        f"      - path: ../../../ios-widget/App {MARK}\n",
        f"      - path: ../../../ios-widget/Shared {MARK}\n",
    ]),
    (find("dependencies") + 1, [
        f"      - target: {EXT_TARGET} {MARK}\n",
    ]),
    (find("entitlements") + 2, [
        f"      properties: {MARK}\n",
        f"        com.apple.security.application-groups: {MARK}\n",
        f"          - group.$(PRODUCT_BUNDLE_IDENTIFIER) {MARK}\n",
    ]),
]
for index, block in sorted(inserts, reverse=True):
    lines[index:index] = block

end += sum(len(block) for _, block in inserts)
extension = f"""{BEGIN}  {EXT_TARGET}:
    type: app-extension
    platform: iOS
    deploymentTarget: "15.0"
    sources:
      - path: ../../../ios-widget/Extension
      - path: ../../../ios-widget/Shared
    info:
      path: {EXT_TARGET}/Info.plist
      properties:
        CFBundleDisplayName: OpenAgentd
        CFBundleShortVersionString: "{version}"
        CFBundleVersion: "{version}"
        OAWidgetAppGroup: group.$(OA_APP_BUNDLE_ID)
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    entitlements:
      path: {EXT_TARGET}/{EXT_TARGET}.entitlements
      properties:
        com.apple.security.application-groups:
          - group.$(OA_APP_BUNDLE_ID)
    dependencies:
      - sdk: SwiftUI.framework
      - sdk: WidgetKit.framework
    settings:
      base:
        OA_APP_BUNDLE_ID: {app_id}
        PRODUCT_BUNDLE_IDENTIFIER: {app_id}.widgets
        PRODUCT_NAME: {EXT_TARGET}
        DEVELOPMENT_TEAM: {team}
        CODE_SIGN_STYLE: Automatic
        SWIFT_VERSION: "5.0"
        TARGETED_DEVICE_FAMILY: "1,2"
        SKIP_INSTALL: true
        ARCHS: [arm64]
        EXCLUDED_ARCHS[sdk=iphoneos*]: x86_64
        LD_RUNPATH_SEARCH_PATHS: "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"
{END}"""
lines[end:end] = [extension]

patched = "".join(lines)
if patched != original:
    open(path, "w").write(patched)
    print(f"patch-ios-widget: patched {path} ({app_id}.widgets)")
    sys.exit(10)
PY
# 10: project.yml changed. Also regenerate when the project lacks the target
# (an Xcode project generated from an unpatched project.yml).
pbxproj="src-tauri/gen/apple/openagentd-mobile.xcodeproj/project.pbxproj"
if [ "$status" -ne 0 ] && [ "$status" -ne 10 ]; then
  exit "$status"
fi
if [ "$status" -eq 10 ] || ! grep -q "OpenAgentdWidgets" "$pbxproj" 2>/dev/null; then
  command -v xcodegen >/dev/null 2>&1 || { echo "patch-ios-widget: xcodegen is required (brew install xcodegen)" >&2; exit 1; }
  (cd src-tauri/gen/apple && xcodegen generate --spec project.yml --quiet)
  echo "patch-ios-widget: regenerated the Xcode project"
fi
