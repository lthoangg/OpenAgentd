#!/usr/bin/env bash
#
# App Store screenshots from the iOS simulators: iPhone 6.9" (1320x2868) and
# iPad 13" (2064x2752), the sizes App Store Connect requires; smaller sizes
# are derived by Apple. No device needed.
#
# Usage: ios-screenshots.sh            (from mobile/, via `make ios-screenshots`)
#
# Environment:
#   SERVER_URL   OpenAgentd server the app shows (default http://127.0.0.1:8000;
#                the simulator reaches the Mac's loopback). Seed it with sample
#                sessions first; a loopback server needs no access key.
#   SESSIONS     space-separated session ids to show in chat (pick ones with
#                an agent working, a plan review, a team run).
#   SHOTS        space-separated `name=deep-link-path` pairs to capture, each
#                opened as openagentd://<path> (default: the new-session
#                screen, each of SESSIONS, then the scheduler).
#   APPEARANCES  "light dark" (default) or one of them.
#   SKIP_BUILD=1 reuse the last simulator build.
#
# Output: mobile/screenshots/{iphone,ipad}/<appearance>-<n>-<name>.png
# (gitignored). The status bar reads 9:41 with full battery and signal.

set -euo pipefail

die() { echo "ios-screenshots: error: $*" >&2; exit 1; }
log() { echo "ios-screenshots: $*"; }

cd "$(dirname "$0")/.."
BUNDLE_ID=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["identifier"])')
SERVER_URL=${SERVER_URL:-http://127.0.0.1:8000}
APPEARANCES=${APPEARANCES:-light dark}
if [ -z "${SHOTS:-}" ]; then
  SHOTS="new=new"
  for id in ${SESSIONS:-}; do SHOTS="$SHOTS chat-${id:0:8}=session/$id"; done
  SHOTS="$SHOTS scheduler=scheduler"
fi
RUNTIME=$(xcrun simctl list runtimes available | awk '/^iOS /{id=$NF} END{print id}')
[ -n "$RUNTIME" ] || die "no iOS simulator runtime; install one in Xcode → Settings → Components"

# device label -> simulator device type (exact App Store sizes)
DEVICES=(
  "iphone|iPhone 17 Pro Max|com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"
  "ipad|iPad Pro 13-inch (M5)|com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB"
)

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  log "building the simulator app"
  (cd src-tauri && cargo tauri ios build --target aarch64-sim --debug)
fi
APP=$(find src-tauri/gen/apple/build -path '*sim*' -name 'OpenAgentd.app' -type d -print0 2>/dev/null \
  | xargs -0 ls -dt 2>/dev/null | head -1)
[ -n "$APP" ] || die "no simulator build of OpenAgentd.app under src-tauri/gen/apple/build"
curl -fsS -m 5 "$SERVER_URL/api/health/live" >/dev/null || die "no OpenAgentd server at $SERVER_URL (start one: agentd server start)"

device_udid() {  # name, type -> udid (created once, reused)
  local name="OpenAgentd $1" udid
  udid=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
name = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["name"] == name:
            print(d["udid"]); raise SystemExit
' "$name")
  [ -n "$udid" ] || udid=$(xcrun simctl create "$name" "$2" "$RUNTIME")
  echo "$udid"
}

for entry in "${DEVICES[@]}"; do
  IFS='|' read -r label title type <<<"$entry"
  udid=$(device_udid "$title" "$type")
  out="screenshots/$label"
  mkdir -p "$out"
  log "$title ($udid)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active \
    --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl install "$udid" "$APP"

  # Point the app at the server before its first launch (app-backend.json in
  # the app's config directory, the same file Settings → Server writes).
  data=$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" data)
  config="$data/Library/Application Support/$BUNDLE_ID"
  mkdir -p "$config"
  printf '{"active_base_url":"%s","servers":[{"base_url":"%s","name":"Studio Mac","enabled":true}]}\n' \
    "$SERVER_URL" "$SERVER_URL" > "$config/app-backend.json"

  for appearance in $APPEARANCES; do
    xcrun simctl ui "$udid" appearance "$appearance"
    xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
    SIMCTL_CHILD_OAD_SCREENSHOT_MODE=1 xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
    sleep 8  # launch, skip the consent (screenshot mode reloads once), load
    n=0
    for shot in $SHOTS; do
      name=${shot%%=*} path=${shot#*=}
      n=$((n + 1))
      xcrun simctl openurl "$udid" "openagentd://$path"
      sleep 4
      file="$out/$appearance-$n-$name.png"
      xcrun simctl io "$udid" screenshot --type=png "$file" >/dev/null
      log "wrote mobile/$file ($(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel/{printf "%s ", $2}'))"
    done
  done
  xcrun simctl status_bar "$udid" clear
done
log "done; check every image before uploading it to App Store Connect"
