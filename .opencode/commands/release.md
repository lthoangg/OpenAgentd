---
applicable_to: Release a new version of OpenAgentd
description: Bump the version, generate release notes, open a PR, then trigger the GitHub Actions release workflow.
subtask: false
---

## Steps

### 1. Propose version bump

Read the current version from `app/version.txt`. Propose a patch increment
(e.g. `0.1.0` → `0.1.1`). Ask explicitly for a minor or major bump.

### 2. Check working tree

Run `git status --short`. Stop if there are uncommitted changes.

### 3. Ask for confirmation

> Ready to release **`<version>`**. Proceed? **(yes / no)**

**Stop and wait for the response.**

### 4. Bump version via pull request

Check for an open PR targeting `main`:

```bash
gh pr list --base main --state open
```

- **PR exists** — commit onto that branch and push. No new branch or PR needed.
- **No open PR** — commit on the current branch, push, and open a PR:

```bash
gh pr create --title "chore: bump version to <version>" --base main
```

Update version in:
- `app/version.txt` — overwrite with `<version>\n`
- `pyproject.toml` — `version = "<version>"` under `[project]`
- `web/package.json` — `"version": "<version>"`

```bash
uv run ruff format app/ tests/
uv run ruff format --check app/ tests/
git add app/version.txt pyproject.toml web/package.json
git commit -m "chore: bump version to <version>"
git push origin <branch>
```

Wait for CI to pass and the PR to be merged.

### 5. Generate release notes

After the PR is merged, collect all commits since the previous tag:

```bash
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)
git log ${PREV_TAG}..HEAD --oneline --no-merges
```

Group commits by conventional type and write release notes in this format:

```markdown
## What's Changed

### Features
- <description> (<short-hash>)

### Fixes
- <description> (<short-hash>)

### Improvements
- <description> (<short-hash>)

### Internal
- <description> (<short-hash>)

**Full Changelog**: https://github.com/lthoangg/openagentd/compare/<prev>...<next>
```

Rules:
- `feat:` → **Features**
- `fix:` → **Fixes**
- `refactor:`, `perf:` → **Improvements**
- `chore:`, `docs:`, `style:`, `test:`, `ci:` → **Internal**
- Skip version bump commits (`chore: bump version`)
- Use the commit subject (strip the `type:` prefix) as the bullet text
- Keep bullets concise — one line each

### 6. Trigger the release workflow

```bash
gh workflow run release.yml --field confirm=release
```

Then run `gh run list --workflow=release.yml --limit=3` to show the queued run.

### 7. Update GitHub release notes

Once the release workflow completes and the GitHub release exists, replace the auto-generated notes:

```bash
gh release edit v<version> --repo lthoangg/openagentd --notes "<release notes from step 5>"
```
