#!/usr/bin/env bash
# Run the backend microbenchmarks (appv3/crates/agent/tests/perf_bench.rs) in
# one checkout and print BENCH lines.
#   scripts/perf/run-backend.sh <repo-root> [label]
# Another checkout runs this checkout's bench: the file is copied in for the
# run (and listed in its tests/main.rs when it is not there), then both files
# are put back as git has them.
set -euo pipefail
tree="$(cd "$1" && pwd)"
label="${2:-$(git -C "$tree" rev-parse --short HEAD)}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
tests=appv3/crates/agent/tests
log="$(mktemp)"
restore() { rm -f "$log"; }
trap restore EXIT
if [ "$tree" != "$repo" ]; then
  grep -q '^autotests = false' "$tree/appv3/crates/agent/Cargo.toml" \
    || { echo "run-backend: $tree builds one test binary per file (a ref before 18 Nov 2026); use a newer baseline" >&2; exit 1; }
  [ -z "$(git -C "$tree" status --porcelain -- "$tests/main.rs" "$tests/perf_bench.rs")" ] \
    || { echo "run-backend: $tree has uncommitted changes in $tests/main.rs or perf_bench.rs" >&2; exit 1; }
  restore() {
    rm -f "$log"
    git -C "$tree" checkout -q -- "$tests/main.rs"
    git -C "$tree" checkout -q -- "$tests/perf_bench.rs" 2>/dev/null || rm -f "$tree/$tests/perf_bench.rs"
  }
  cp "$repo/$tests/perf_bench.rs" "$tree/$tests/perf_bench.rs"
  grep -q '^mod perf_bench;' "$tree/$tests/main.rs" || printf 'mod perf_bench;\n' >>"$tree/$tests/main.rs"
fi
cd "$tree/appv3"
if ! cargo test -q --release -p appv3-agent --test integration perf_bench:: -- --ignored --nocapture --test-threads=1 >"$log" 2>&1; then
  tail -30 "$log" >&2
  exit 1
fi
# The first line follows the test's name on the same line.
grep -o 'BENCH .*' "$log" | sed "s/^BENCH /BENCH [$label] /"
