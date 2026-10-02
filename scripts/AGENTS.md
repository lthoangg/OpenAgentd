# Maintainer Scripts Guide

This subtree owns repository validation, release/version maintenance, icon
generation, updater helpers, and code-health analysis.

## Ownership

- `validate_docs.py`: Markdown links/frontmatter and documented Make target
  contracts.
- `codehealth/`: stdlib analyzer for Python/TypeScript size, complexity,
  coupling, and import cycles. `make health` and `make health-json` analyze
  the web frontend only; `--lang python` still reaches the frozen v2 `app/`.
- `generate_icons.py`: shared source-icon conversion for native targets.
- `make_updater_manifest.py` and `generate_updater_keys.sh`: desktop updater
  metadata and local key setup.
- `release_version.sh`, `bump_version.sh`, `check_version_consistency.sh`, and
  `release_commits_since_last_tag.sh`: synchronized release metadata and
  release-note inputs. The `[workspace.package]` version in
  `appv3/Cargo.toml` is the release version.
- `e2e_cli_install.sh` and `fake_release_server.py`: CLI install and
  self-update end-to-end check used by the appv3 workflow.
- `tests/`: pytest checks for these scripts and for installer, native-shell
  config, and release-workflow contracts; run them with `make verify-scripts`.

The repository has no Python project. Scripts run with `python3` and the
standard library (plus Pillow for `generate_icons.py`); `make verify-scripts`
installs the test dependencies into the local, git-ignored `.venv`. Keep scripts
non-interactive by default, repository-root-relative, and portable across
supported platforms.

## Safety and generated outputs

- Do not run version bump, signing-key, manifest, publish, or release helpers
  merely to verify documentation. Inspect `--help` or source and use the
  smallest non-mutating path.
- Never embed signing material, tokens, or machine-local paths. Updater private
  keys remain outside the repository.
- Sidecar bundles, Cargo targets, web distributions, and generated native
  platform trees are build output. Change source inputs and rerun their owning
  script/Make target.
- Version changes must use the release workflow so the appv3 workspace, web,
  desktop, mobile, Tauri configs, lockfiles, and feature-catalogue metadata
  stay in sync. `make verify-version` is the gate.

## Checks

Choose the focused safe command, then the owning repository target:

```bash
python3 scripts/validate_docs.py
python3 scripts/make_updater_manifest.py --help
python3 -m scripts.codehealth --help
make verify-scripts
make verify-docs
make verify-version
```

For sidecar changes, run `make -C desktop sidecar` when feasible. For icon,
release, updater, or packaging changes, report any platform/signing step that
could not be exercised locally.
