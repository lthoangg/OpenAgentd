#!/usr/bin/env bash
# End-to-end check of the CLI install and self-update paths against a local
# fake release server, entirely inside a temp sandbox:
#
#   1. install.sh --cli (or install.ps1 -Cli on Windows) installs BINARY as
#      release 3.0.0 after verifying its checksum;
#   2. a tampered checksum is refused and installs nothing;
#   3. `agentd upgrade` self-updates to a newer release (the same binary
#      repackaged as 99.0.0).
#
# Releases ship `agentd` plus the `openagentd` alias, which is expected
# beside BINARY (cargo builds both into the same directory).
#
# Usage: scripts/e2e_cli_install.sh <path to agentd binary> [target triple]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=$1
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;;
  *) WINDOWS=0 ;;
esac
if [ -n "${2:-}" ]; then
  TARGET=$2
elif [ "$WINDOWS" = 1 ]; then
  TARGET=x86_64-pc-windows-msvc
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) TARGET=aarch64-apple-darwin ;;
    Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
    *) echo "unsupported host" >&2; exit 2 ;;
  esac
fi
PY=$(command -v python3 || command -v python)

SB=$(mktemp -d)
# Mixed form (C:/…) works for Git Bash and for the Windows programs it starts.
[ "$WINDOWS" = 1 ] && SB=$(cygpath -m "$SB")
SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true; rm -rf "$SB"; }
trap cleanup EXIT

# Sandbox HOME and every OpenAgentd directory.
export HOME="$SB/home" USERPROFILE="$SB/home" LOCALAPPDATA="$SB/localappdata" OPENAGENTD_ENV=production
export OPENAGENTD_MODEL_REGISTRY_REFRESH=false OPENAGENTD_HIDE_V2_NOTICE=1
export OPENAGENTD_DATA_DIR="$SB/oad/data" OPENAGENTD_CONFIG_DIR="$SB/oad/config" OPENAGENTD_STATE_DIR="$SB/oad/state" OPENAGENTD_CACHE_DIR="$SB/oad/cache" OPENAGENTD_WORKSPACE_DIR="$SB/oad/ws"
export OPENAGENTD_INSTALL_DIR="$SB/install"
mkdir -p "$HOME" "$LOCALAPPDATA"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

EXE=""; [ "$WINDOWS" = 1 ] && EXE=".exe"
ALIAS="$(dirname "$BIN")/openagentd$EXE"
[ -x "$ALIAS" ] || { echo "FAIL: no openagentd alias beside $BIN" >&2; exit 2; }

pack() { # version outdir
  local st="$SB/stage-$1" name="openagentd-$1-$TARGET" archive
  mkdir -p "$st" "$2"
  cp "$BIN" "$st/agentd$EXE"
  cp "$ALIAS" "$st/openagentd$EXE"
  chmod 755 "$st/agentd$EXE" "$st/openagentd$EXE"
  cp "$ROOT/LICENSE" "$st/"
  if [ "$WINDOWS" = 1 ]; then
    archive="$name.zip"
    (cd "$st" && 7z a -tzip "$2/$archive" ./* >/dev/null)
  else
    archive="$name.tar.gz"
    COPYFILE_DISABLE=1 tar -C "$st" -czf "$2/$archive" .
  fi
  echo "$(sha256 "$2/$archive")  $archive" > "$2/$archive.sha256"
}

serve() { # latest dir
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true
  : > "$SB/port"
  LATEST=$1 DIR=$2 "$PY" "$ROOT/scripts/fake_release_server.py" > "$SB/port" 2> "$SB/server.log" &
  SRV=$!
  # A cold runner's first Python start can take well over 10 s.
  for _ in $(seq 600); do [ -s "$SB/port" ] && break; sleep 0.1; done
  local port
  port=$(head -n1 "$SB/port" | tr -d '\r')
  [ -n "$port" ] || { cat "$SB/server.log" >&2; echo "FAIL: fake release server did not report a port" >&2; exit 1; }
  export OPENAGENTD_RELEASES_URL="http://127.0.0.1:$port"
}

install_cli() {
  if [ "$WINDOWS" = 1 ]; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ROOT/install.ps1")" -Cli
  else
    sh "$ROOT/install.sh" --cli
  fi
}

INSTALLED="$OPENAGENTD_INSTALL_DIR/agentd$EXE"
VERSION=$("$BIN" --version | tr -d '\r' | sed 's/^agentd v//')

echo "=== install $VERSION ==="
pack "$VERSION" "$SB/rel-current"
serve "$VERSION" "$SB/rel-current"
install_cli
[ "$("$INSTALLED" --version | tr -d '\r')" = "agentd v$VERSION" ] || { echo "FAIL: installed version"; exit 1; }
[ "$("$OPENAGENTD_INSTALL_DIR/openagentd$EXE" --version | tr -d '\r')" = "agentd v$VERSION" ] || { echo "FAIL: openagentd alias"; exit 1; }
[ ! -e "$OPENAGENTD_INSTALL_DIR/LICENSE" ] || { echo "FAIL: non-executable installed"; exit 1; }
echo "PASS: install"

echo "=== tampered checksum ==="
sums=$(ls "$SB"/rel-current/*.sha256)
cp "$sums" "$SB/sha.bak"
echo "0000000000000000000000000000000000000000000000000000000000000000  x" > "$sums"
if OPENAGENTD_INSTALL_DIR="$SB/other" install_cli > "$SB/tamper.log" 2>&1; then echo "FAIL: tampered archive installed"; exit 1; fi
grep -qi "checksum mismatch" "$SB/tamper.log" || { cat "$SB/tamper.log"; echo "FAIL: wrong error"; exit 1; }
[ ! -e "$SB/other/agentd$EXE" ] || { echo "FAIL: files placed"; exit 1; }
cp "$SB/sha.bak" "$sums"
echo "PASS: tampered checksum refused"

echo "=== self-update to 99.0.0 ==="
pack 99.0.0 "$SB/rel-next"
serve 99.0.0 "$SB/rel-next"
"$INSTALLED" upgrade | tee "$SB/upgrade.log"
grep -q "Updated v$VERSION → v99.0.0" "$SB/upgrade.log" || { echo "FAIL: no update"; exit 1; }
# The upgrade replaced the running binary (on Windows via rename-aside).
"$INSTALLED" --version >/dev/null
echo "PASS: self-update"
echo "ALL PASSED ($TARGET)"
