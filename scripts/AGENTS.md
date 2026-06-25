# scripts/ — Agent Instructions

Maintainer scripts for benchmarks, sidecar packaging, updater keys, and release manifest generation.

## Tech stack

- Python scripts are run with the repo's `uv` environment unless the script explicitly documents otherwise.
- Shell helper: `generate_updater_keys.sh`.

## Scripts

```
build_sidecar.py              Build the desktop Python sidecar bundle
make_updater_manifest.py      Generate updater release manifests
update_model_registry.py      Refresh bundled model metadata from models.dev
codehealth/                   Rank god files + map deps + detect import cycles
bump_version.sh               Update release-facing versions and refresh lockfiles
check_version_consistency.sh  Verify all release-facing versions stay in sync
render_release_install_block.sh Render release-note Install block from published assets
generate_updater_keys.sh      Tauri updater signing key helper
```

### codehealth — refactor targeting

Stdlib-only analyzer (Python `ast` + regex for TS/TSX). Scores files by a blend
of LOC, longest-function LOC, peak cyclomatic complexity, and coupling
(`fan_in * fan_out`) so genuine "god files" outrank merely-long ones. Also runs
Tarjan SCC over the intra-project import graph to surface circular imports.

```bash
make health                                   # ranked text report (top 25)
make health-json                              # JSON (baselines / CI diffs)
uv run python -m scripts.codehealth --help
uv run python -m scripts.codehealth --lang python --top 15
uv run python -m scripts.codehealth --lang ts --top 15
# CI gate: fail the build if anything regresses past budget or a cycle appears
uv run python -m scripts.codehealth --max-score 1300 --fail-on-cycles
```

Use it *before* a refactor to pick targets and *after* to confirm the score
dropped and no new cycles were introduced. Implementation is Python (not shell)
because it parses ASTs, builds an import graph, and must run on Windows too.

## Essential commands

```bash
scripts/bump_version.sh --help
scripts/check_version_consistency.sh
scripts/render_release_install_block.sh --help
uv run python scripts/build_sidecar.py --help
uv run python scripts/make_updater_manifest.py --help
uv run python scripts/update_model_registry.py --help
make -C desktop sidecar
```

## Conventions

- Keep scripts non-interactive by default and safe to run from the repo root.
- Prefer argparse help text over separate usage comments.
- Do not embed signing keys, tokens, or machine-specific paths.
- Packaging scripts should preserve cross-platform behavior for macOS, Linux, and Windows.

## Checks

Run the script's `--help` and the smallest focused dry-run or target command available. For sidecar changes, also use `make -C desktop sidecar` when feasible.
