#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

usage() {
    cat <<'EOF'
Usage: scripts/check_version_consistency.sh

Verify that all release-facing version files match app/version.txt.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

if [ $# -ne 0 ]; then
    echo "error: unexpected arguments" >&2
    usage >&2
    exit 2
fi

json_get() {
    python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
print(json.loads(path.read_text())[key])
PY
}

extract_toml_version() {
    sed -n 's/^version = "\([^"]*\)".*/\1/p' "$1" | head -n 1
}

assert_equal() {
    label=$1
    actual=$2
    expected=$3
    printf '%-38s %s\n' "$label" "$actual"
    if [ "$actual" != "$expected" ]; then
        echo "" >&2
        echo "ERROR: version mismatch in $label" >&2
        echo "expected: $expected" >&2
        echo "actual:   $actual" >&2
        exit 1
    fi
}

ROOT_VERSION=$(tr -d '[:space:]' < app/version.txt)
assert_equal "app/version.txt" "$ROOT_VERSION" "$ROOT_VERSION"
assert_equal "pyproject.toml" "$(extract_toml_version pyproject.toml)" "$ROOT_VERSION"
assert_equal "web/package.json" "$(json_get web/package.json version)" "$ROOT_VERSION"
assert_equal "desktop/src-tauri/Cargo.toml" "$(extract_toml_version desktop/src-tauri/Cargo.toml)" "$ROOT_VERSION"
assert_equal "desktop/src-tauri/tauri.conf.json" "$(json_get desktop/src-tauri/tauri.conf.json version)" "$ROOT_VERSION"
assert_equal "mobile/src-tauri/Cargo.toml" "$(extract_toml_version mobile/src-tauri/Cargo.toml)" "$ROOT_VERSION"
assert_equal "mobile/src-tauri/tauri.conf.json" "$(json_get mobile/src-tauri/tauri.conf.json version)" "$ROOT_VERSION"
assert_equal "desktop/src-tauri/Cargo.lock" "$(sed -n '/name = "openagentd-desktop"/{n;s/^version = "\([^"]*\)"/\1/p;q;}' desktop/src-tauri/Cargo.lock)" "$ROOT_VERSION"
assert_equal "mobile/src-tauri/Cargo.lock" "$(sed -n '/name = "openagentd-mobile"/{n;s/^version = "\([^"]*\)"/\1/p;q;}' mobile/src-tauri/Cargo.lock)" "$ROOT_VERSION"

echo "Versions match."
