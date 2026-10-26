---
name: oad/release
description: OpenAgentd release workflow — pick the version, bump every release file, ship the version PR, publish the CLI and desktop releases to one tag, and write user-facing release notes. Use when asked to cut, prepare, or publish a release.
---

One version, one tag (`v<X.Y.Z>`), two publishing workflows. The
`[workspace.package]` version in `appv3/Cargo.toml` is the single source of truth.
Repository: `lthoangg/openagentd`.

## 1. Pick the version

```bash
scripts/release_version.sh                       # current version (e.g. 3.5.0)
scripts/release_commits_since_last_tag.sh --stat # what ships
git status --short                               # must be clean; stop if not
```

Judge from the diff, not branch names:
- new capability → minor (`3.5.0` → `3.6.0`);
- fixes, maintenance, docs, tests → patch (`3.5.0` → `3.5.1`); a run of patch releases stays patch;
- breaking change → ask whether a major bump is intended.

Propose the version and wait for the user to confirm.

## 2. Issues and docs

```bash
gh issue list --repo lthoangg/openagentd --state open --search "<area from the diff>" --limit 20
```

- Triage related issues as fixed, partial, or unrelated. Fixed → `Fixes #<n>` in the
  PR body; related but open → `Refs #<n>`. Comment on an issue when the link is not obvious.
- User-visible changes need entries in `documents/docs/features.md` with this
  version before the bump PR (see `oad/commit` for what belongs there). If none are
  needed, say why in the PR body.

## 3. Version PR

Check CI on `main` first; do not bump on a red `main`:

```bash
for wf in appv3.yml web.yml tauri.yml docs.yml; do gh run list --workflow=$wf --branch=main --limit=1; done
gh run view <run-id> --log-failed   # when one failed
```

Then bump and verify:

```bash
scripts/bump_version.sh <version>   # or --from-file after editing appv3/Cargo.toml by hand
make verify-version                 # versions and features.md metadata agree
```

`bump_version.sh` updates `appv3/Cargo.toml` + lock, `web/package.json`, the desktop
and mobile `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`, and the `updated:` /
`Latest release:` lines in `features.md`. Commit only those files:

```bash
git add appv3/Cargo.toml appv3/Cargo.lock web/package.json \
  desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
  mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml mobile/src-tauri/Cargo.lock \
  documents/docs/features.md
git commit -m "chore: bump version to <version>"
git push -u origin <branch>
gh pr create --base main --title "<title>" --body "<bullets>"
```

- Reuse the feature branch when there is one. Title: `chore: bump version to <version>`
  for a metadata-only bump, otherwise the user-facing change with the range, e.g.
  `Fix desktop update restart (v3.5.0 -> v3.5.1)`.
- Body: one bullet per user-visible change, then the issue links, then
  "Update backend, web, desktop, mobile, and lockfile versions to <version>."
- Watch checks in this session (`gh pr checks <n> --watch`); version-check runs on
  version files. Do not schedule background follow-ups.
- **Build the mobile apps while CI runs.** CI only runs `cargo check` for mobile, so it
  never links the iOS or Android binaries; a link error (it happened in v3.31.0) shows up
  only in a real build. Treat these local builds as part of CI, and start them right after
  `gh pr create`, on the PR branch, in the background:

  ```bash
  DRY_RUN=1 make -C mobile ios-release                 # archive + package IPA, no upload
  source ~/.android/openagentd-release-env.sh          # JAVA_HOME, keystore, Keychain password
  DRY_RUN=1 make -C mobile android-release             # build + sign APK, no upload
  ```

  `DRY_RUN=1` runs the whole build and the checks, but uploads nothing. Before the tag
  exists it skips the tag and release checks with a warning. Run them one after the
  other (both touch `mobile/src-tauri`).
  If either fails, fix it on the PR branch before merging. Do not merge on a build
  that only CI has checked.
- Read review comments (`gh pr view <n> --comments`), fix valid ones on the branch,
  answer false positives with a one-line reason, and re-check CI after each push.
- Merge: `gh pr merge <n> --merge --delete-branch` (keep history; `--squash` only for a
  single logical change). `--admin` bypasses branch protection: ask first.
  `main` requires one approving review, so a self-authored PR is blocked without
  `--admin`: ask about `--admin` as soon as CI is green, not after a failed merge.
- Run the merge as its own command. Never chain it with `;`, a pipe, or the
  publish commands: a pipe like `| tail` hides the failure and the release then
  runs on the old `main`.

## 4. Publish

Publish only after the merge is confirmed. The gate must pass first; `set -e` stops
here on any mismatch:

```bash
set -e
test "$(gh pr view <n> --json state -q .state)" = MERGED
git checkout main && git pull --ff-only
git status -sb | head -1                          # must be "## main...origin/main", not ahead/behind
test "$(scripts/release_version.sh)" = <version>  # origin/main carries the bump
```

If any check fails, stop and fix the merge. Do not dispatch `release.yml`.

```bash
gh workflow run release.yml -f confirm=release        # creates v<version>, CLI archives (~5 min)
gh run watch "$(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')"
```

Check that the run's `headSha` is the merge commit
(`gh run list --workflow=release.yml --limit=1 --json headSha`). If you dispatched
on the wrong commit, cancel the run at once (`gh run cancel <id>`).

Write the notes (step 5) and apply them before the desktop build:

```bash
gh release edit v<version> --repo lthoangg/openagentd --notes-file /tmp/release-notes-v<version>.md
gh workflow run release-desktop.yml -f confirm=release-desktop -f channel=stable   # ~25 min
```

- `release-desktop.yml` also takes `platform` (`all`, `windows`, `macos`, `linux`) and
  `run_id` (republish artifacts of an earlier run). It bundles the CLI archive
  `release.yml` published, so run it second.
- It uploads the installers and `latest.json` to the same tag and mirrors
  `latest.json` to the rolling `latest-desktop` release the updater reads.
- Homebrew formula and cask publish automatically after each workflow completes.
- If the push-triggered `tauri.yml` fails after the bump, the usual cause is a
  stale desktop or mobile `Cargo.lock`: fix it on `main` before rerunning.

Build and upload the iOS sideload IPA locally while `release-desktop.yml` runs.
CI does not build iOS; this step needs a Mac with Xcode and the signing team from
`mobile/src-tauri/tauri.conf.json`:

```bash
git fetch --tags && git checkout v<version>   # HEAD must be the tagged commit
DRY_RUN=1 make -C mobile ios-release      # optional preview: checks + mobile/dist/source.json
make -C mobile ios-release                # build, package, upload IPA + .sha256 and source.json
git checkout main
```

- `ios-release` uploads `OpenAgentd_<version>_iOS.ipa` and its `.sha256` to
  `v<version>`. It also refreshes `source.json` on the rolling `latest-ios`
  pre-release that SideStore reads; the feed's What's New text is the release body.
  Apply the notes first.
- The script refuses a dirty tree, a HEAD other than the tag, or a missing
  release. Re-running is safe (`--clobber`; the feed replaces the same version).
- If the iOS build cannot run, say so in the release report; the rest of the
  release does not depend on it.
- If the build broke only after tagging, fix it on `main` and ship the IPA with
  `ALLOW_AFTER_TAG=1 make -C mobile ios-release` from that commit. Leave the tag
  alone: the CLI, desktop and Homebrew assets are already published from it, so moving
  it breaks them. The IPA descends from the tag plus the fix; add one line to the
  release notes saying the iOS build includes `<short-sha>`.

Afterwards, confirm the notes survived and the IPA is attached
(`gh release view v<version> --repo lthoangg/openagentd`), and that
`gh release view latest-ios --repo lthoangg/openagentd` lists `source.json`.

Build and upload the Android APK locally the same way. CI does not build
Android. You need JDK 17+, the Android SDK and NDK (see `mobile/README.md`),
and the **release keystore**. Android only installs updates signed with the
key that signed the installed app, so always use the same keystore and never
lose it:

```bash
git fetch --tags && git checkout v<version>   # HEAD must be the tagged commit
export ANDROID_KEYSTORE=/path/to/openagentd-release.jks ANDROID_KEY_ALIAS=openagentd
export ANDROID_KEYSTORE_PASSWORD=...          # ANDROID_KEY_PASSWORD if it differs
DRY_RUN=1 make -C mobile android-release      # optional preview: build + checks, no upload
make -C mobile android-release                # build, sign, upload APK + .sha256
git checkout main
```

- `android-release` uploads `OpenAgentd_<version>_Android.apk` and its
  `.sha256` to `v<version>`. It refuses to start without `ANDROID_KEYSTORE`.
  `publish-apk.sh` refuses a debug-signed APK, a dirty tree, a HEAD other than
  the tag, or a missing release. Re-running is safe (`--clobber`).
- If the Android build cannot run, say so in the release report; the rest of
  the release does not depend on it.

## 5. Release notes

```bash
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)
git log ${PREV_TAG}..HEAD --no-merges --format=fuller
```

- Read each commit's body and changed files, not just subjects; skip version bumps
  and commits unrelated to this release.
- `## What's changed`: one bullet per user-visible outcome, grouping commits that ship
  one outcome. Lead with the behavior change; paraphrase, no internals or file paths.
- `## Breaking Changes` only when users must migrate, with just the steps.
- No install, upgrade, or test sections (installation lives in the README), no marketing language.
- End with `**Full changelog:** https://github.com/lthoangg/openagentd/compare/<prev>...v<version>`.
- Write the file under `/tmp`, never in the repository.
