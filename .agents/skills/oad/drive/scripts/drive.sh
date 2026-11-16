#!/usr/bin/env bash
# Start, check, drive and stop a second OpenAgentd instance that is safe to
# exercise: its own ports, its own data, and a scripted stand-in model.
#
#   drive.sh up                 build, then start the model stub, the backend and the web UI
#   drive.sh doctor             read-only: is this instance ours and worth driving?
#   drive.sh run [journey…]     run the journeys at a phone and a desktop width (default: all)
#   drive.sh down               stop what `up` started; evidence stays
#
# Isolation: HOME and every OPENAGENTD_* directory live in $DRIVE_DIR, so your
# sessions, settings, keys and git identity are never read or written. No
# provider key is loaded: the only model is the stub on $MODEL_PORT, which
# answers over three wire protocols (see stub_model.py).
# Evidence goes to $EVIDENCE_ROOT/<run>/ and is never removed by this script.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
HERE="$ROOT/.agents/skills/oad/drive/scripts"
DRIVE_DIR=${DRIVE_DIR:-/tmp/oad-drive}
API_PORT=${API_PORT:-8791}
WEB_PORT=${WEB_PORT:-5191}
MODEL_PORT=${MODEL_PORT:-8792}
EVIDENCE_ROOT=${EVIDENCE_ROOT:-$ROOT/.openagentd/drive}
API="http://127.0.0.1:$API_PORT/api"
WEB="http://localhost:$WEB_PORT"

log() { printf '[drive] %s\n' "$*"; }
fail() { printf '[drive] %s\n' "$*" >&2; exit 1; }

listener() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }

# The pid in $1's pid file, when that process is still alive.
alive() { [[ -f "$DRIVE_DIR/$1.pid" ]] && kill -0 "$(cat "$DRIVE_DIR/$1.pid")" 2>/dev/null && cat "$DRIVE_DIR/$1.pid"; }

# Whether the process listening on port $2 is the one we started as $1, or its child.
owns() {
  local ours port_pid
  ours=$(alive "$1") || return 1
  port_pid=$(listener "$2")
  [[ -n "$port_pid" ]] || return 1
  [[ "$port_pid" == "$ours" || "$(ps -o ppid= -p "$port_pid" | tr -d ' ')" == "$ours" ]]
}

stop() {
  local pid
  if pid=$(alive "$1"); then
    pkill -P "$pid" 2>/dev/null || true # children first (vite's workers)
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -f "$DRIVE_DIR/$1.pid"
}

cmd_down() {
  stop web
  stop api
  stop model
  log "stopped (evidence stays in $EVIDENCE_ROOT)"
}

cmd_up() {
  cmd_down >/dev/null
  case "$DRIVE_DIR" in /tmp/*|/private/tmp/*|/var/folders/*) ;; *) fail "DRIVE_DIR must live under /tmp" ;; esac
  if [[ -e "$DRIVE_DIR" && ! -f "$DRIVE_DIR/.oad-drive" ]]; then
    fail "$DRIVE_DIR exists and was not created by this script; pick another DRIVE_DIR"
  fi
  for port in "$API_PORT" "$WEB_PORT" "$MODEL_PORT"; do
    [[ -z "$(listener "$port")" ]] || fail "port $port is taken by pid $(listener "$port"); set API_PORT, WEB_PORT or MODEL_PORT"
  done
  rm -rf "$DRIVE_DIR"
  mkdir -p "$DRIVE_DIR"/{home,data,config,state,cache,workspace,memory,code/demo}
  touch "$DRIVE_DIR/.oad-drive"

  # A small repository for the journeys to work in.
  (
    cd "$DRIVE_DIR/code/demo"
    git init -q -b main
    printf '# demo\n\nA repository the drive journeys change.\n' >README.md
    printf 'export const greeting = "hello"\n' >greeting.ts
    git add -A
    git -c user.name=drive -c user.email=drive@example.invalid commit -q -m "start"
  )

  log "building backend"
  cargo build -q --manifest-path "$ROOT/appv3/Cargo.toml" -p appv3-cli

  log "starting model stub on :$MODEL_PORT"
  python3 "$HERE/stub_model.py" --port "$MODEL_PORT" --log "$DRIVE_DIR/model.jsonl" >"$DRIVE_DIR/model.log" 2>&1 &
  echo $! >"$DRIVE_DIR/model.pid"
  wait_for "model stub" "http://127.0.0.1:$MODEL_PORT/v1/models" model

  log "starting isolated backend on :$API_PORT"
  (
    # A clean environment: nothing from the shell that started us (keys,
    # desktop tokens, OPENAGENTD_* of another instance) reaches this server.
    cd "$DRIVE_DIR"
    exec env -i PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" SHELL="${SHELL:-/bin/sh}" \
      HOME="$DRIVE_DIR/home" OPENAGENTD_ENV=production \
      OPENAGENTD_DATA_DIR="$DRIVE_DIR/data" OPENAGENTD_CONFIG_DIR="$DRIVE_DIR/config" \
      OPENAGENTD_STATE_DIR="$DRIVE_DIR/state" OPENAGENTD_CACHE_DIR="$DRIVE_DIR/cache" \
      OPENAGENTD_WORKSPACE_DIR="$DRIVE_DIR/workspace" AGENT_MEMORY_DIR="$DRIVE_DIR/memory" \
      OLLAMA_BASE_URL="http://127.0.0.1:$MODEL_PORT/v1" \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$MODEL_PORT" ANTHROPIC_API_KEY="drive-stub-not-a-key" \
      "$ROOT/appv3/target/debug/agentd" server serve --port "$API_PORT"
  ) >"$DRIVE_DIR/api.log" 2>&1 &
  echo $! >"$DRIVE_DIR/api.pid"
  wait_for "backend" "$API/health/ready" api

  # Point every seeded agent at the stub.
  for f in "$DRIVE_DIR"/config/agents/*.md; do
    python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
open(path, "w").write(re.sub(r"^model: .*$", "model: ollama:stub", text, count=1, flags=re.M))
PY
  done

  # Have the backend read each provider's model list from the stub, as the
  # Settings page does when a provider is connected.
  for provider in ollama anthropic; do
    curl -sf -X POST "$API/settings/providers/$provider/models" -H 'Content-Type: application/json' -d '{}' >/dev/null \
      || fail "the backend could not list $provider models from the stub"
  done

  log "starting web UI on :$WEB_PORT"
  (cd "$ROOT/web" && VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" exec bun x vite --port "$WEB_PORT" --strictPort) \
    >"$DRIVE_DIR/web.log" 2>&1 &
  echo $! >"$DRIVE_DIR/web.pid"
  wait_for "web UI" "$WEB/" web
  cmd_doctor
  log "ready: $WEB (sandbox: $DRIVE_DIR)"
}

# wait_for <label> <url> <pid-name>: until the URL answers, or the process dies, or 120 s pass.
wait_for() {
  local i
  for i in $(seq 1 600); do
    curl -sf "$2" >/dev/null 2>&1 && return 0
    alive "$3" >/dev/null || { tail -20 "$DRIVE_DIR/$3.log" >&2; fail "$1 exited while starting; see $DRIVE_DIR/$3.log"; }
    sleep 0.2
  done
  fail "$1 did not answer at $2 within 120 s; see $DRIVE_DIR/$3.log"
}

cmd_doctor() {
  local bad=0
  check() { if "${@:2}" >/dev/null 2>&1; then log "ok    $1"; else log "FAIL  $1"; bad=1; fi; }
  check "sandbox was created by this script ($DRIVE_DIR)" test -f "$DRIVE_DIR/.oad-drive"
  check "model stub is ours and listens on :$MODEL_PORT" owns model "$MODEL_PORT"
  check "backend is ours and listens on :$API_PORT" owns api "$API_PORT"
  check "web UI is ours and listens on :$WEB_PORT" owns web "$WEB_PORT"
  check "backend answers /api/health/ready" curl -sf "$API/health/ready"
  check "every backend module started" modules_ok
  check "backend runs the current build" build_is_current
  check "web UI serves the app" curl -sf "$WEB/"
  [[ $bad -eq 0 ]] || fail "not worth driving: run 'drive.sh up' again"
}

modules_ok() {
  curl -sf "$API/modules" | python3 -c '
import json, sys
mods = json.load(sys.stdin)
mods = mods.get("modules", mods) if isinstance(mods, dict) else mods
bad = [m.get("id") for m in mods if m.get("state") != "running"]
sys.exit(1 if bad or not mods else 0)'
}

# The binary on disk is not newer than the running server (a rebuild since `up`).
build_is_current() {
  local pid
  pid=$(alive api) || return 1
  [[ ! "$ROOT/appv3/target/debug/agentd" -nt "$DRIVE_DIR/api.pid" ]]
}

cmd_run() {
  cmd_doctor
  [[ -d "$ROOT/scripts/readme-shots/node_modules/playwright" ]] || (cd "$ROOT/scripts/readme-shots" && bun install --silent)
  local run_dir
  run_dir="$EVIDENCE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$run_dir"
  DRIVE_DIR="$DRIVE_DIR" WEB_URL="$WEB" API="$API" OUT_DIR="$run_dir" ROOT="$ROOT" bun "$HERE/journeys.mjs" "$@"
}

case "${1:-}" in
  up) cmd_up ;;
  doctor) cmd_doctor ;;
  run) shift; cmd_run "$@" ;;
  down) cmd_down ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
