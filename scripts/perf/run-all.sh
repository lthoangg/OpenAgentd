#!/usr/bin/env bash
# Before/after performance run: a baseline ref (default: the latest release
# tag) against this checkout.
#   scripts/perf/run-all.sh [base-ref]
# Results go to $OAD_PERF_DIR/results-<ts>.txt (default /tmp/oadperf).
# Run on an otherwise idle machine; every step runs one at a time.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
here="$repo/scripts/perf"
base_ref="${1:-$(git -C "$repo" describe --tags --abbrev=0)}"
work="${OAD_PERF_DIR:-/tmp/oadperf}"
out="$work/results-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$work"

if [ ! -d "$work/base" ]; then git -C "$repo" worktree add --detach "$work/base" "$base_ref"; fi
git -C "$work/base" checkout -q --detach "$base_ref"
for t in "$work/base" "$repo"; do
  (cd "$t/appv3" && cargo build -q --release -p appv3-cli)
  (cd "$t/web" && bun install --frozen-lockfile >/dev/null)
done

# One seeded database, shared by both servers (the schema is unchanged).
mkdir -p "$work/ws"
rm -f "$work/seed.db" "$work/seed.db-wal" "$work/seed.db-shm"
lead="$(cd "$repo/appv3" && OAD_SEED_DB="$work/seed.db" OAD_SEED_WS="$work/ws" cargo test -q --release -p appv3-agent --test integration perf_seed_reopen:: -- --ignored --nocapture 2>/dev/null | sed -n 's/^.*SEEDED lead=//p')"
[ -n "$lead" ] || { echo "run-all: seeding the reopen database failed" >&2; exit 1; }
sqlite3 "$work/seed.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
export OAD_LEAD="$lead"
# Older history pages the web client fetches by itself on open (AUTO_PROMPT_SEEK_PAGES).
older="${OAD_PERF_OLDER_PAGES:-2}"
{
  "$here/run-backend.sh" "$work/base" base
  "$here/run-backend.sh" "$repo" head
  python3 "$here/reopen.py" "$work/base/appv3/target/release/agentd" "$work/seed.db" base "$older"
  python3 "$here/reopen.py" "$repo/appv3/target/release/agentd" "$work/seed.db" head "$older"
  "$here/run-web.sh" "$work/base" base
  "$here/run-web.sh" "$repo" head
  "$here/run-browser.sh" "$work/base=base" "$repo=head"
} | tee "$out"
echo "results: $out"
