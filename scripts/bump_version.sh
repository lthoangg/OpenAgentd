#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

usage() {
    cat <<'EOF'
Usage: scripts/bump_version.sh <version>

Update all release-facing version files from app/version.txt or the provided
version, then refresh lockfiles.

Examples:
  scripts/bump_version.sh 1.66.0
  scripts/bump_version.sh --from-file
EOF
}

version=${1:-}
if [ "$version" = "-h" ] || [ "$version" = "--help" ]; then
    usage
    exit 0
fi

if [ "$version" = "--from-file" ]; then
    if [ $# -ne 1 ]; then
        echo "error: --from-file does not accept extra arguments" >&2
        exit 2
    fi
    version=$(tr -d '[:space:]' < app/version.txt)
elif [ $# -eq 1 ]; then
    :
else
    echo "error: expected exactly one version argument or --from-file" >&2
    usage >&2
    exit 2
fi

case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
        echo "error: version must look like X.Y.Z" >&2
        exit 2
        ;;
esac

current_version=$(tr -d '[:space:]' < app/version.txt)
if [ "$current_version" != "$version" ]; then
    printf '%s\n' "$version" > app/version.txt
fi

replace_exact_line() {
    file=$1
    old=$2
    new=$3
    python3 - "$file" "$old" "$new" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
old = sys.argv[2]
new = sys.argv[3]
text = path.read_text()
count = text.count(old)
if count != 1:
    raise SystemExit(f"error: expected exactly one occurrence in {path}: {old!r}, found {count}")
path.write_text(text.replace(old, new, 1))
PY
}

replace_json_version() {
    file=$1
    python3 - "$file" "$version" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
data = json.loads(path.read_text())
data["version"] = version
path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

replace_exact_line pyproject.toml \
    "version = \"$current_version\"  # keep in sync with app/version.txt" \
    "version = \"$version\"  # keep in sync with app/version.txt"
replace_json_version web/package.json
replace_exact_line desktop/src-tauri/Cargo.toml "version = \"$current_version\"" "version = \"$version\""
replace_json_version desktop/src-tauri/tauri.conf.json
replace_exact_line mobile/src-tauri/Cargo.toml "version = \"$current_version\"" "version = \"$version\""
replace_json_version mobile/src-tauri/tauri.conf.json

release_date_iso=$(date -u +%F)
release_date_human=$(LC_ALL=C date -u '+%B %-d, %Y' 2>/dev/null || LC_ALL=C date -u '+%B %d, %Y' | sed 's/ 0/ /')
replace_exact_line documents/docs/features.md \
    "updated: $(sed -n 's/^updated: //p' documents/docs/features.md | head -n 1)" \
    "updated: $release_date_iso"
replace_exact_line documents/docs/features.md \
    "**Latest release:** v$(sed -n 's/^\*\*Latest release:\*\* v\([^ ]*\) .*$/\1/p' documents/docs/features.md | head -n 1) · $(sed -n 's/^\*\*Latest release:\*\* v[^·]* · \([^[]*\) \[release notes\].*$/\1/p' documents/docs/features.md | head -n 1) [release notes](https://github.com/lthoangg/openagentd/releases/tag/v$(sed -n 's/^\*\*Latest release:\*\* v\([^ ]*\) .*$/\1/p' documents/docs/features.md | head -n 1))" \
    "**Latest release:** v$version · $release_date_human · [release notes](https://github.com/lthoangg/openagentd/releases/tag/v$version)"

uv sync

# ``cargo update --workspace`` refreshes only the workspace member's own entry
# in Cargo.lock, which is all a version bump needs. ``cargo generate-lockfile``
# used to be here and re-resolved the whole graph ("Locking 511 packages to
# latest compatible versions"), which:
#
#   1. shipped Rust dependency versions no PR ever tested, and
#   2. changed the Cargo.lock/Cargo.toml hash that Swatinem/rust-cache keys on,
#      so every release commit missed the primary cache key and fell back to a
#      stale entry, re-downloading and recompiling dependencies.
#
# Dependency updates belong in their own PR, where CI can test them.
cargo update --workspace --manifest-path desktop/src-tauri/Cargo.toml
cargo update --workspace --manifest-path mobile/src-tauri/Cargo.toml

scripts/check_version_consistency.sh

echo "Bumped release-facing versions to $version"
