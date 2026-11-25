#!/usr/bin/env bash
# Browser measurements (browser_measure.mjs) of the production web bundle of
# one or two checkouts, against one isolated release backend.
#   scripts/perf/run-browser.sh <repo-root>[=label] [<repo-root>[=label]]
# Starts the drive sandbox on its own ports and folder, seeds it, puts the
# delay proxy in front of it, builds and serves each checkout's web/dist,
# measures, and stops what it started. With two checkouts the runs alternate
# between them. The same checkout twice (`.=a .=b`) shows how far two
# identical builds differ, which is the noise of the machine.
# RUNS, ONLY and DELAYS pass through to browser_measure.mjs.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
here="$repo/scripts/perf"
drive="$repo/.agents/skills/oad/drive/scripts/drive.sh"
if [ $# -lt 1 ] || [ $# -gt 2 ]; then sed -n '2,10p' "$0" >&2; exit 1; fi
# Its own sandbox and ports, so a drive session in use is left alone.
export DRIVE_DIR="${OAD_PERF_SANDBOX:-/tmp/oad-perf-drive}" API_PORT=8794 MODEL_PORT=8795 WEB_PORT=5196
export DRIVE_PROFILE=release DRIVE_STUB_ARGS="--reply-chars 20000"
proxy_port=8796
port=5197
out="${OAD_PERF_DIR:-/tmp/oadperf}"
mkdir -p "$out"

pids=""
cleanup() {
  for pid in $pids; do
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  "$drive" down >/dev/null 2>&1 || true
}
trap cleanup EXIT
wait_for() {
  for _ in $(seq 1 300); do
    curl -sf "$1" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "run-browser: $1 did not answer within 60 s" >&2
  exit 1
}

"$drive" up >&2
PORT="$proxy_port" TARGET="http://127.0.0.1:$API_PORT" bun "$here/browser_proxy.mjs" &
pids="$pids $!"
wait_for "http://127.0.0.1:$proxy_port/__stats"
echo "[perf] seeding the sandbox (about four minutes)" >&2
seeded="$(API="http://127.0.0.1:$API_PORT/api" WORKSPACE="$DRIVE_DIR/code/demo" bun "$here/browser_seed.mjs")"
long="$(printf '%s\n' "$seeded" | sed -n 's/^SEEDED long=\([^ ]*\) work=.*/\1/p')"
work="$(printf '%s\n' "$seeded" | sed -n 's/^SEEDED long=[^ ]* work=//p')"
[ -n "$long" ] && [ -n "$work" ] || { echo "run-browser: seeding the sandbox failed" >&2; exit 1; }
[ -d "$repo/scripts/readme-shots/node_modules/playwright" ] || (cd "$repo/scripts/readme-shots" && bun install --silent)

targets=""
built=""
for arg in "$@"; do
  tree="$(cd "${arg%%=*}" && pwd)"
  label="${arg#*=}"
  [ "$label" != "$arg" ] || label="$(git -C "$tree" rev-parse --short HEAD)"
  case " $built " in
    *" $tree "*) ;;
    *)
      echo "[perf] building the web bundle of $tree" >&2
      (cd "$tree/web" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null) \
        || { echo "run-browser: the web build failed in $tree" >&2; exit 1; }
      built="$built $tree"
      ;;
  esac
  (cd "$tree/web" && VITE_API_PROXY_TARGET="http://127.0.0.1:$proxy_port" exec bun x vite preview --port "$port" --strictPort >/dev/null 2>&1) &
  pids="$pids $!"
  wait_for "http://localhost:$port/"
  targets="${targets:+$targets,}$label=http://localhost:$port"
  port=$((port + 1))
done

ROOT="$repo" TARGETS="$targets" PROXY="http://127.0.0.1:$proxy_port" API="http://127.0.0.1:$API_PORT/api" LONG="$long" WORK="$work" \
  OUT="$out/browser-$(date +%Y%m%d-%H%M%S).json" bun "$here/browser_measure.mjs"
