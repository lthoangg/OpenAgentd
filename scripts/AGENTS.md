# Maintainer Scripts Guide

This subtree owns repository validation, release/version maintenance, icon
generation, updater helpers, and code-health analysis.

## Ownership

- `validate_docs.py`: Markdown links/frontmatter and documented Make target
  contracts.
- `codehealth/`: stdlib analyzer for Python/TypeScript size, complexity,
  coupling, and import cycles. `make health` and `make health-json` analyze
  the web frontend only; `--lang python` analyzes `scripts/`.
- `brand/`: the logo's source of truth. `brand.ts` (its own Bun package, with
  Schibsted Grotesk and its OFL license in `fonts/`) builds the Seal and the
  wordmark from the font and writes `web/src/lib/brand/logo-data.ts`, the
  logo files and favicons under `documents/assets/brand/`, the platform icon
  masters, `web/public/` favicons, and the boot loader's inline Seal in
  `web/index.html`. Run `bun install --cwd scripts/brand && bun
  scripts/brand/brand.ts`, then `python3 scripts/generate_icons.py --force`.
  openagentd.dev copies the logo from here; never redraw it by hand.
- `generate_icons.py`: turns the brand masters into every native icon
  (desktop `.icns`/`.ico`/PNGs and tray template, iOS and Android launcher
  icons) through `cargo tauri icon`.
- `make_updater_manifest.py` and `generate_updater_keys.sh`: desktop updater
  metadata and local key setup.
- `make_sidestore_source.py`: SideStore/AltStore source feed for the iOS
  sideload IPA, generated from the IPA's `Info.plist` by
  `mobile/scripts/publish-ipa.sh`.
- `release_version.sh`, `bump_version.sh`, `check_version_consistency.sh`, and
  `release_commits_since_last_tag.sh`: synchronized release metadata and
  release-note inputs. The `[workspace.package]` version in
  `appv3/Cargo.toml` is the release version.
- `e2e_cli_install.sh` and `fake_release_server.py`: CLI install and
  self-update end-to-end check used by the appv3 workflow.
- `readme-shots/`: regenerates the README screenshots and banner from a
  throwaway instance. `run.sh up` starts an isolated backend and web UI (HOME
  and every data directory under `/tmp/oad-demo`, invented demo repos from
  `demo-repos.sh`), `run.sh stage` runs real agent sessions (`stage.py`, a few
  cents of model calls using keys from `.env`), `run.sh capture [scene…]` takes
  light and dark shots into `documents/assets/readme/` (`capture.mjs`), and
  `banner.mjs` renders `documents/assets/brand/banner/banner.html`. Never point
  it at a real data directory: screenshots must not show user sessions or paths.
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
