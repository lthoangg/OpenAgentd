---
name: oad/release
description: OpenAgentd workflow for version bumps, release PRs, GitHub releases, and release notes.
---

## Steps

1. Version target:

- Read `app/version.txt`.
- Determine the bump from the actual diff content, not the branch name:
  - **Feature or new capability**: bump minor, e.g. `1.0.0` -> `1.1.0`.
  - **Bug fix, maintenance, docs, tests, or internal-only change**: bump patch, e.g. `1.0.0` -> `1.0.1`.
  - **Patch-only releases stay patch-only**: continue incrementing the patch number, e.g. `1.0.5` -> `1.0.6`; do not bump minor just because there have been several patches.
  - **Breaking change**: ask whether a major bump is intended.
- Propose the calculated version and confirm with the user before applying it.
- Branch prefix (`feat/`, `fix/`, `chore/`) is not signal — judge from diff content.

2. Worktree check:

- Stop if dirty.

```bash
git status --short
```

3. Related GitHub issues:

- Before confirming the release, search for issues related to the actual diff and intended release notes. Do not rely only on branch names or commit subjects.

```bash
git branch --show-current
git log --oneline --no-merges main..HEAD
gh issue list --repo lthoangg/openagentd --state open --search "<keyword from diff or feature area>" --limit 20
gh issue list --repo lthoangg/openagentd --state all --search "<keyword from diff or feature area> in:title,body" --limit 20
gh issue view <issue-number> --repo lthoangg/openagentd --comments --json number,title,state,labels,body,comments
```

- Triage each related issue as **included/fixed**, **partially included**, **not included**, or **unrelated**.
- If the release fully fixes or ships an issue, include `Fixes #<issue-number>` or `Closes #<issue-number>` in the release PR body so GitHub closes it on merge; use `Refs #<issue-number>` when the release is related but should not close it.
- Tag included issues when useful for tracking. Prefer an existing milestone/label convention if present; otherwise create and apply a version label:

```bash
gh label create "included-in-v<version>" --repo lthoangg/openagentd --description "Included in v<version>" --color "0E8A16" || true
gh issue edit <issue-number> --repo lthoangg/openagentd --add-label "included-in-v<version>"
```

- Add a short issue comment when the relationship is not obvious, especially for partial inclusion or when using `Refs` instead of `Fixes`:

```bash
gh issue comment <issue-number> --repo lthoangg/openagentd --body "Included in the v<version> release PR: <pr-url>."
```

4. Documentation readiness:

- Before confirming the release, inspect the canonical feature catalogue and README for user-visible changes.

```bash
git diff --name-only main..HEAD
git diff --stat main..HEAD -- documents/docs/features.md README.md documents/adrs
```

- For user-visible features, behavior changes, install/update changes, or removed/deprecated functionality, update `documents/docs/features.md` first; it is the canonical feature catalogue.
- Update `README.md` only when the product story or first-run setup changes.
- Track future work, bugs, and roadmap changes in GitHub issues rather than repository roadmap or technical-debt documents.
- Keep implementation, API, configuration, CLI, operation, and UI details in source, tests, CLI help, and the UI. Record only significant, expensive-to-reverse decisions as ADRs.
- If no documentation changes are needed, record the rationale in the release PR body (for example: `Docs: no user-facing behavior changed`).
- Include required feature-catalogue, README, or ADR updates in the feature branch before the version bump PR is created; do not leave release-blocking docs fixes until after publishing.

5. Confirm release:

> Ready to release **`<version>`**. Proceed? **(yes / no)**

6. Version PR:

- **Before bumping, verify CI is green on `main`.** Check both the `Core` (pytest) and `Web` (lint + typecheck + tests) workflows on the latest commit:

```bash
# Get the SHA of the commit you are about to release from
git rev-parse HEAD

# List the most recent runs of each CI workflow and confirm conclusion=success
gh run list --workflow=core.yml --branch=main --limit=3
gh run list --workflow=web.yml  --branch=main --limit=3

# If either shows failure, inspect and fix before continuing:
gh run view <run-id> --log-failed
```

- Do **not** proceed with the version bump if any required CI workflow is failing on `main`. Fix the failures first, push the fix to `main`, confirm CI goes green, then resume the release.
- Reuse the existing feature branch when present; do not spin a fresh `release/` branch on top of it.
- `app/version.txt` is the **single human-edited source of truth** for release versioning.
- Use the release helper to propagate that version to every release-facing file, refresh lockfiles, and update release docs metadata:

```bash
scripts/bump_version.sh <version>
```

- The helper updates and/or refreshes:
  - `app/version.txt`
  - `pyproject.toml`
  - `uv.lock`
  - `web/package.json`
  - `desktop/src-tauri/tauri.conf.json`
  - `desktop/src-tauri/Cargo.toml`
  - `desktop/src-tauri/Cargo.lock`
  - `mobile/src-tauri/tauri.conf.json`
  - `mobile/src-tauri/Cargo.toml`
  - `mobile/src-tauri/Cargo.lock`
  - `documents/docs/features.md` (`updated:` and `Latest release:`)
- **Why this matters:** `app/version.txt` drives the tag name both release workflows use (`v<X.Y.Z>`), while bundled artefacts and app metadata read from the Tauri/Cargo files, and CI also enforces `cargo check --locked` for desktop/mobile. The helper keeps those surfaces in sync instead of relying on manual multi-file edits.
- Run the consistency check explicitly before committing if you want a standalone verification step:

```bash
scripts/check_version_consistency.sh
```

- Metadata-only title: `chore: bump version to <version>`.
- User-facing change title: describe change, append range.
- Example: `Fix frontend update restart (v0.3.3 -> v0.3.4)`.
- PR body must be a bullet list summarizing the included user-facing changes, not a single generic sentence.

```bash
uv run ruff format app/ tests/
uv run ruff format --check app/ tests/
git add app/version.txt pyproject.toml uv.lock web/package.json \
        desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml \
        desktop/src-tauri/Cargo.lock \
        mobile/src-tauri/tauri.conf.json mobile/src-tauri/Cargo.toml \
        mobile/src-tauri/Cargo.lock \
        documents/docs/features.md
git commit -m "<release commit title>"
git push -u origin <branch>
gh pr create --title "<release PR title>" --body "<bullet-point release summary>" --base main
```

- PR body shape:

  ```markdown
  Release PR for v<version>.

  - Add or improve <user-visible outcome>.
  - Fix <user-visible bug or behavior>.
  - Update desktop, mobile, backend, web, and lockfile versions in lockstep to <version>.
  ```

- Watch CI in-session until it completes. Do **not** create scheduled reminders or background follow-up tasks; keep polling directly in the current release workflow:

```bash
gh pr checks <pr-number> --watch
# or, if --watch is not suitable:
gh pr checks <pr-number>
```

- Check PR review comments before merging:

```bash
gh pr view <pr-number> --comments --json comments,reviews
gh api repos/lthoangg/openagentd/pulls/<pr-number>/comments \
  --jq '.[] | "FILE: \(.path):\(.line // .original_line)\nAUTHOR: \(.user.login)\n---\n\(.body)\n==="'
```

- Triage each comment: apply valid ones as additional commits on the same branch, defer false-positives with a one-line rationale.
- Re-poll CI after each push.
- Merge PR:
  - Default: `gh pr merge <pr-number> --merge --delete-branch --admin` to preserve the multi-commit history of the feature branch.
  - Use `--squash` only when the branch is a single logical change (e.g. metadata-only bump).
  - `--admin` is required when branch protection blocks solo-author PRs on `REVIEW_REQUIRED`; confirm with the user before using it.

7. Merge and release notes:

- After CI is green and comments are handled, merge the PR, then generate notes from `main`.

```bash
git checkout main && git pull --ff-only
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)
git log ${PREV_TAG}..HEAD --oneline --no-merges
```

- Skip commits unrelated to this branch's user-facing work (e.g. earlier docs-only commits that landed on `main` separately).
- Tight, user-facing notes.
- Prefer detailed bullets for `## What's changed`; one bullet per user-visible capability, fix, or behavior change.
- Inspect each included commit's full message body, stats, and changed files before drafting bullets. Do not rely on commit subjects alone:

  ```bash
  git log ${PREV_TAG}..HEAD --format=fuller --no-merges
  git show --stat --oneline <commit>...
  git show --name-only --format=fuller <commit>...
  ```

- Group related commits into a single bullet when they ship one visible outcome, but split distinct outcomes even if they landed in the same area.
- Skip version-bump commits.
- Treat commit subjects as raw material.
- Paraphrase; do not transcribe.
- Lead with user-visible behavior change.
- Avoid internals unless required to explain a fix.
- Keep each bullet concise; include enough detail that users can tell what changed without reading the changelog.

Sections:

- `## Breaking Changes`: only if migration required. Include only the required migration steps.
- `## What's changed`: bullet list of user-noticeable changes, grouped by outcome.
- Installation and upgrade guidance belongs in the README, not the release notes. Link to the README only when readers need it to act on a breaking change.
- End with `**Full changelog:** https://github.com/lthoangg/openagentd/compare/<prev>...<next>`.
- Avoid `## Tests` section.
- Avoid internal file paths.
- Avoid marketing language.
- Avoid restating section headings.

8. Trigger CLI release:

Both workflows publish into the **same** `v<X.Y.Z>` tag (introduced in
1.0.9 — older releases used a separate `v<X.Y.Z>-desktop` tag). Whichever
workflow runs first creates the release; the other appends artefacts via
`gh release upload --clobber`. Run `release.yml` first so the canonical
auto-generated notes come from the PyPI workflow.

```bash
# CLI / PyPI release (~90 seconds)
gh workflow run release.yml --field confirm=release
gh run list --workflow=release.yml --limit=3
# Watch this workflow in-session until status=completed conclusion=success before continuing.
```

9. Trigger desktop release:

```bash
# Desktop release (~20–25 minutes for the matrix build)
gh workflow run release-desktop.yml --field confirm=release-desktop --field channel=stable
gh run list --workflow=release-desktop.yml --limit=3
# Watch this workflow in-session until status=completed conclusion=success.
```

- **Do not patch release notes before the desktop workflow finishes.** The desktop workflow re-uploads `latest.json` and can rewrite the release body as a side effect (observed on v1.24.0 — notes patched between the CLI and desktop runs were reverted to the auto-generated text). Wait for `status=completed conclusion=success` on `release-desktop.yml` before editing.
- If the push-triggered `tauri.yml` workflow fails right after the version-bump commit, inspect it before retrying the release workflows. The common failure mode is stale `desktop/src-tauri/Cargo.lock` / `mobile/src-tauri/Cargo.lock`; fix those on `main`, push, and re-run the release only after `tauri.yml` is green.

10. GitHub release notes:

- Only after **both** workflows finish, draft concise, user-facing notes. Focus on `## What's changed`, adding `## Breaking Changes` only when migration is required. Keep installation and upgrade instructions in the README.
- Write the drafted release notes to an OS temp path (for example `/tmp/release-notes-v<version>.md`), not to a file under the repository workspace. This keeps ad-hoc release artefacts out of the repo tree.
- Replace the auto-generated notes from that `/tmp` file, then verify:

```bash
gh release edit v<version> --repo lthoangg/openagentd --notes-file /tmp/release-notes-v<version>.md
gh release view v<version> --repo lthoangg/openagentd | sed -n '/## What.s changed/,/Full changelog/p'
```

- Final verification — confirm the release body contains no `## Install` or `## Upgrade` sections:

```bash
gh release view v<version> --repo lthoangg/openagentd | grep -E '^## (Install|Upgrade)' && exit 1 || true
```
