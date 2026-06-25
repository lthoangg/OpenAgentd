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
bump_version.sh               Update release-facing versions and refresh lockfiles
check_version_consistency.sh  Verify all release-facing versions stay in sync
generate_updater_keys.sh      Tauri updater signing key helper
```

## Essential commands

```bash
scripts/bump_version.sh --help
scripts/check_version_consistency.sh
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
