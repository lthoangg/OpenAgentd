# Maintainer Scripts Guide

This subtree owns repository validation, release/version maintenance, sidecar
packaging, icon generation, updater helpers, benchmarks, and code-health
analysis.

## Ownership

- `validate_docs.py`: Markdown links/frontmatter and documented Make target
  contracts.
- `codehealth/`: stdlib analyzer for Python/TypeScript size, complexity,
  coupling, and import cycles; invoke through `make health` or
  `make health-json`.
- `build_sidecar.py`: generated desktop Python sidecar bundle.
- `generate_icons.py`: shared source-icon conversion for native targets.
- `make_updater_manifest.py` and `generate_updater_keys.sh`: desktop updater
  metadata and local key setup.
- `bump_version.sh`, `check_version_consistency.sh`, and
  `release_commits_since_last_tag.sh`: synchronized release metadata and
  release-note inputs.
- `bench_chat_db.py`: local persistence benchmark, not a correctness test.

Python scripts use the repository `uv` environment unless the script's help or
owning Make target explicitly uses system Python. Keep scripts non-interactive
by default, repository-root-relative, and portable across supported platforms.

## Safety and generated outputs

- Do not run version bump, signing-key, manifest, publish, or release helpers
  merely to verify documentation. Inspect `--help` or source and use the
  smallest non-mutating path.
- Never embed signing material, tokens, or machine-local paths. Updater private
  keys remain outside the repository.
- Sidecar bundles, Cargo targets, web distributions, and generated native
  platform trees are build output. Change source inputs and rerun their owning
  script/Make target.
- Version changes must use the release workflow so Python, web, desktop,
  mobile, Tauri configs, lockfiles, and feature-catalogue metadata stay in
  sync. `make verify-version` is the gate.

## Checks

Choose the focused safe command, then the owning repository target:

```bash
uv run python scripts/validate_docs.py
uv run python scripts/build_sidecar.py --help
uv run python scripts/make_updater_manifest.py --help
uv run python -m scripts.codehealth --help
make verify-docs
make verify-version
```

For sidecar changes, run `make -C desktop sidecar` when feasible. For icon,
release, updater, or packaging changes, report any platform/signing step that
could not be exercised locally.
