#!/usr/bin/env bash
# Regenerate the README screenshots from a throwaway, fully isolated instance.
#
#   scripts/readme-shots/run.sh up        fresh sandbox + demo repos, start backend and web UI
#   scripts/readme-shots/run.sh stage     run the demo agent sessions (real model calls)
#   scripts/readme-shots/run.sh capture   take light + dark screenshots into documents/assets/readme/
#   scripts/readme-shots/run.sh down      stop the sandbox servers
#
# Isolation: the backend runs with HOME and every OPENAGENTD_* directory inside
# $SHOTS_DIR, so your sessions, settings, skills, memory, shell rc files and git
# identity never reach a screenshot. Only provider API keys are read, from
# $SHOTS_ENV_FILE (default: the repository .env); they are never rendered.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/scripts/readme-shots"
SHOTS_DIR=${SHOTS_DIR:-/tmp/oad-demo}
API_PORT=${API_PORT:-8787}
WEB_PORT=${WEB_PORT:-5199}
MODEL=${MODEL:-openai:gpt-6-luna}
THINKING=${THINKING:-medium}
SHOTS_ENV_FILE=${SHOTS_ENV_FILE:-$ROOT/.env}
API="http://127.0.0.1:$API_PORT/api"

log() { printf '\033[2m[shots]\033[0m %s\n' "$*"; }

stop_pid() { [[ -f "$1" ]] && kill "$(cat "$1")" 2>/dev/null || true; rm -f "$1"; }

cmd_down() {
  stop_pid "$SHOTS_DIR/api.pid"
  stop_pid "$SHOTS_DIR/web.pid"
  log "stopped"
}

cmd_up() {
  cmd_down
  case "$SHOTS_DIR" in /tmp/*|/private/tmp/*|/var/folders/*) ;; *) echo "SHOTS_DIR must live under /tmp" >&2; exit 1 ;; esac
  if [[ -e "$SHOTS_DIR" && ! -f "$SHOTS_DIR/.readme-shots" ]]; then
    echo "$SHOTS_DIR exists and was not created by this script; pick another SHOTS_DIR" >&2
    exit 1
  fi
  rm -rf "$SHOTS_DIR"
  mkdir -p "$SHOTS_DIR"/{home,data,config,state,cache,workspace,memory,code}
  touch "$SHOTS_DIR/.readme-shots"
  "$HERE/demo-repos.sh" "$SHOTS_DIR/code" >/dev/null

  log "building backend"
  cargo build -q --manifest-path "$ROOT/appv3/Cargo.toml" -p appv3-cli

  log "starting isolated backend on :$API_PORT"
  (
    set -a
    # shellcheck disable=SC1090
    [[ -f "$SHOTS_ENV_FILE" ]] && . "$SHOTS_ENV_FILE"
    set +a
    export OPENAGENTD_ENV=production HOME="$SHOTS_DIR/home" \
      OPENAGENTD_DATA_DIR="$SHOTS_DIR/data" OPENAGENTD_CONFIG_DIR="$SHOTS_DIR/config" \
      OPENAGENTD_STATE_DIR="$SHOTS_DIR/state" OPENAGENTD_CACHE_DIR="$SHOTS_DIR/cache" \
      OPENAGENTD_WORKSPACE_DIR="$SHOTS_DIR/workspace" AGENT_MEMORY_DIR="$SHOTS_DIR/memory"
    cd "$SHOTS_DIR"
    exec "$ROOT/appv3/target/debug/agentd" server serve --port "$API_PORT"
  ) >"$SHOTS_DIR/api.log" 2>&1 &
  echo $! >"$SHOTS_DIR/api.pid"
  until curl -sf "$API/health" >/dev/null 2>&1 || curl -sf "$API/agent/sessions" >/dev/null 2>&1; do sleep 0.2; done

  # Point the seeded agents at the demo model. Responses API + a thinking level
  # is what current OpenAI reasoning models require for tool calls.
  for f in "$SHOTS_DIR"/config/agents/*.md; do
    python3 - "$f" "$MODEL" "$THINKING" <<'PY'
import re, sys
path, model, thinking = sys.argv[1:]
text = open(path).read()
text = re.sub(r"^model: .*$", f"model: {model}\nthinking_level: {thinking}\nresponses_api: true", text, count=1, flags=re.M)
open(path, "w").write(text)
PY
  done

  log "starting web UI on :$WEB_PORT"
  (cd "$ROOT/web" && VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" exec bun x vite --port "$WEB_PORT" --strictPort) \
    >"$SHOTS_DIR/web.log" 2>&1 &
  echo $! >"$SHOTS_DIR/web.pid"
  until curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1; do sleep 0.2; done
  log "ready → http://localhost:$WEB_PORT (sandbox: $SHOTS_DIR)"
}

cmd_stage() {
  SHOTS_DIR="$SHOTS_DIR" API="$API" python3 "$HERE/stage.py"
}

cmd_capture() {
  [[ -d "$HERE/node_modules/playwright" ]] || (cd "$HERE" && bun install --silent)
  (cd "$HERE" && SHOTS_DIR="$SHOTS_DIR" WEB_URL="http://localhost:$WEB_PORT" API="$API" \
    OUT_DIR="$ROOT/documents/assets/readme" bun capture.mjs "$@")
}

case "${1:-}" in
  up) cmd_up ;;
  stage) cmd_stage ;;
  capture) shift; cmd_capture "$@" ;;
  down) cmd_down ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
